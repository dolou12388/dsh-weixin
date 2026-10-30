/**
 * 媒体收发：微信 CDN 的 AES-128-ECB 上传/下载与消息封装。
 *
 * 协议要点（逆向自上游 `cdn/` 与 `media/`，不可自行推导）：
 *   - 上传前先 `getUploadUrl` 拿一次性上传地址，服务端要 rawsize / md5 / 密文大小
 *   - 上传体必须是 **AES-128-ECB 加密后的密文**，不是明文
 *   - 下载参数从上传响应的 `x-encrypted-param` 头取回
 *   - 下载时 `aes_key` 有两种编码：base64(16 原始字节) 与 base64(32 位 hex 字符串)
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { getUploadUrl } from "../protocol/api.js";
import { logger } from "../util/logger.js";

/** 媒体项类型（对齐协议）。 */
export const ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
};

/** 上传媒体类型。 */
export const UPLOAD_MEDIA_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
};

/** 单文件上限 100 MiB。 */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/** CDN 上传最大重试次数。 */
const UPLOAD_MAX_RETRIES = 3;

/**
 * 计算 AES-128-ECB 加密后的长度（PKCS7 填充）。
 *
 * @param {number} plaintextSize - 明文长度
 * @returns {number} 密文长度
 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * AES-128-ECB 加密。
 *
 * @param {Buffer} plaintext - 明文
 * @param {Buffer} key - 16 字节密钥
 * @returns {Buffer} 密文
 */
export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * AES-128-ECB 解密。
 *
 * @param {Buffer} ciphertext - 密文
 * @param {Buffer} key - 16 字节密钥
 * @returns {Buffer} 明文
 */
export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 解析 CDNMedia.aes_key。
 *
 * 线上存在两种编码，必须都支持，否则会出现"图片能收不能发"这类半瘫：
 *   - base64(16 原始字节)          → 图片
 *   - base64(32 位 hex 字符串)     → 文件/语音/视频
 *
 * @param {string} aesKeyBase64 - 原始字段
 * @param {string} label - 日志标签
 * @returns {Buffer} 16 字节密钥
 */
export function parseAesKey(aesKeyBase64, label) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;

  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) {
    return Buffer.from(ascii, "hex");
  }

  throw new Error(
    `${label}: aes_key 必须解出 16 字节或 32 位 hex，实际 ${decoded.length} 字节`,
  );
}

/**
 * 由 MIME 猜微信的媒体类别。
 *
 * @param {string} mime - MIME
 * @returns {"video"|"image"|"file"} 类别
 */
export function classifyMime(mime) {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  return "file";
}

/**
 * 从文件名猜 MIME（只覆盖常见类型，够用即可）。
 *
 * @param {string} name - 文件名或路径
 * @returns {string} MIME
 */
export function guessMime(name) {
  const ext = path.extname(name).toLowerCase().replace(".", "");
  const table = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    silk: "audio/silk",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    zip: "application/zip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return table[ext] ?? "application/octet-stream";
}

/**
 * 按文件头嗅探图片扩展名。
 *
 * 微信下发的图片一律没有可信扩展名（本地实测是 JPEG），直接写 `.png`
 * 会让下游按扩展名判 MIME 的地方全部判断错误——包括 Agent 自己的看图工具。
 *
 * @param {Buffer} buf - 文件内容
 * @returns {string} 扩展名（不含点），无法识别时回退 `bin`
 */
export function sniffImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return "bin";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF"
    && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  return "bin";
}

/**
 * 上传一个本地文件到微信 CDN。
 *
 * 流程对齐上游：读文件 → md5 → 生成 filekey/aeskey → getUploadUrl →
 * AES 加密后 POST → 从响应头取下载参数。
 *
 * @param {object} params - 参数
 * @param {string} params.filePath - 本地路径
 * @param {string} params.toUserId - 接收者
 * @param {object} params.account - 账号（baseUrl / token / cdnBaseUrl）
 * @param {string} params.kind - `image` / `video` / `file`
 * @returns {Promise<object>} 上传结果
 */
export async function uploadMedia(params) {
  const { filePath, toUserId, account, kind } = params;

  const stat = await fs.stat(filePath);
  if (stat.size > MAX_MEDIA_BYTES) {
    throw new Error(`文件超过微信上限 100MiB: ${filePath} (${stat.size} bytes)`);
  }

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const mediaType =
    kind === "image"
      ? UPLOAD_MEDIA_TYPE.IMAGE
      : kind === "video"
        ? UPLOAD_MEDIA_TYPE.VIDEO
        : UPLOAD_MEDIA_TYPE.FILE;

  logger.info(
    `uploadMedia: kind=${kind} file=${path.basename(filePath)} rawsize=${rawsize} `
      + `filesize=${filesize} md5=${rawfilemd5.slice(0, 8)}…`,
  );

  const resp = await getUploadUrl({
    baseUrl: account.baseUrl,
    token: account.token,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadFullUrl = resp?.upload_full_url?.trim();
  const uploadParam = resp?.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`getUploadUrl 未返回上传地址: ${JSON.stringify(resp).slice(0, 200)}`);
  }

  const cdnBaseUrl = account.cdnBaseUrl || deriveCdnBaseUrl(account.baseUrl);
  const url = uploadFullUrl
    || `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}`
      + `&filekey=${encodeURIComponent(filekey)}`;

  const ciphertext = encryptAesEcb(plaintext, aeskey);
  if (ciphertext.length !== filesize) {
    // 密文长度与 getUploadUrl 报给服务端的 filesize 必须严格一致，
    // 差一个字节服务端就认为文件被截断，可能拒绝或让客户端下载失败
    throw new Error(
      `密文长度不符: 实际 ${ciphertext.length} != 声明 ${filesize} (rawsize=${rawsize})`,
    );
  }
  const downloadParam = await postToCdn(url, ciphertext);

  const aeskeyHex = aeskey.toString("hex");
  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskeyHex,
    // **微信的 aes_key 是「hex 字符串再 base64」**，不是「16 字节原始值 base64」。
    // 解码后必须是 32 字节 ASCII（32 位 hex），客户端才能还原出真正的密钥。
    // 直接传 16 字节的 base64 也能拿到 message_id（服务端只校验结构），
    // 但客户端解密失败 → 图片/文件卡片静默不渲染，表现为「服务端说发了、微信里没有」。
    // 入站图片的 aes_key 也是同一套编码，`parseAesKey` 两种都兼容。
    aeskeyBase64: Buffer.from(aeskeyHex, "utf8").toString("base64"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/**
 * 把密文 POST 到 CDN，取回 `x-encrypted-param`。
 *
 * 4xx 直接失败（重试无意义），5xx 与网络错误重试。
 *
 * @param {string} url - 上传地址
 * @param {Buffer} ciphertext - 密文
 * @returns {Promise<string>} 下载参数
 */
async function postToCdn(url, ciphertext) {
  let lastError;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text().catch(() => ""));
        throw new Error(`CDN 客户端错误 ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN 服务端错误: ${errMsg}`);
      }

      const param = res.headers.get("x-encrypted-param");
      if (!param) throw new Error("CDN 响应缺少 x-encrypted-param");
      return param;
    } catch (err) {
      lastError = err;
      // 客户端错误不重试
      if (String(err).includes("客户端错误")) throw err;

      if (attempt < UPLOAD_MAX_RETRIES) {
        logger.warn(`uploadMedia: 第 ${attempt} 次失败, 重试中: ${String(err)}`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("CDN 上传失败");
}

/**
 * 从 API baseUrl 推导 CDN baseUrl。
 *
 * 上游的 CDN 域名与 API 域名不同（`ilinkai.weixin.qq.com` vs CDN 域名），
 * 服务端一般会在 `getUploadUrl` 里返回完整地址；只有拿不到时才用这个兜底。
 *
 * @param {string} apiBaseUrl - API 地址
 * @returns {string} CDN 地址
 */
export function deriveCdnBaseUrl(apiBaseUrl) {
  try {
    const u = new URL(apiBaseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return apiBaseUrl;
  }
}

/**
 * 下载并解密一个 CDN 媒体项。
 *
 * @param {object} media - `{ encrypt_query_param, aes_key, full_url }`
 * @param {string} cdnBaseUrl - CDN 地址
 * @param {string} label - 日志标签
 * @returns {Promise<Buffer>} 明文
 */
export async function downloadMedia(media, cdnBaseUrl, label) {
  const param = media?.encrypt_query_param;
  const fullUrl = media?.full_url;
  if (!param && !fullUrl) throw new Error(`${label}: 缺少下载参数`);

  const url = fullUrl
    || `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(param)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label}: CDN 下载失败 ${res.status} ${res.statusText}`);
  }
  const encrypted = Buffer.from(await res.arrayBuffer());

  // 没有 aes_key 时按明文处理（图片分支允许）
  if (!media.aes_key) return encrypted;

  const key = parseAesKey(media.aes_key, label);
  return decryptAesEcb(encrypted, key);
}

/**
 * 构造图片消息项。
 *
 * @param {object} uploaded - `uploadMedia` 的返回
 * @returns {object} item
 */
export function buildImageItem(uploaded) {
  return {
    type: ITEM_TYPE.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aeskeyBase64,
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
}

/**
 * 构造视频消息项。
 *
 * @param {object} uploaded - `uploadMedia` 的返回
 * @returns {object} item
 */
export function buildVideoItem(uploaded) {
  return {
    type: ITEM_TYPE.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aeskeyBase64,
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };
}

/**
 * 构造文件消息项。
 *
 * @param {object} uploaded - `uploadMedia` 的返回
 * @param {string} fileName - 展示用文件名
 * @returns {object} item
 */
export function buildFileItem(uploaded, fileName) {
  return {
    type: ITEM_TYPE.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aeskeyBase64,
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
}
