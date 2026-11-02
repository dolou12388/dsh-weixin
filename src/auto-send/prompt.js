/**
 * 自动发送的提示词构造。
 *
 * 两段式：用户的自由指令 + 固定的输出约束。
 * 约束单独拼、不由用户覆盖，因为它们是"能不能用"的前提而不是偏好：
 *   - 要求纯正文：模型很爱加"好的，我这样回复："之类的开场，
 *     这些字会原样进到微信里，观感很差。
 *   - 禁止工具调用：自动发送的回合没有人在屏幕前处理权限确认，
 *     一旦模型决定读文件/跑命令，这个回合会长时间挂着，最后什么都不发。
 *   - 字数上限：冒泡应该是短句，长回复应当走正常对话。
 */

/** 内置默认指令。 */
export const DEFAULT_AUTO_SEND_INSTRUCTION = [
  "这是一次自动发起对话的机会，没有人正在输入。",
  "请结合你和对方之前的聊天内容，主动发一条简短、自然、有信息量的消息。",
  "可以延续上次的话题、分享一个刚想到的点、或提一个具体的小问题；",
  "不要复述对方说过的话，不要用「你还在吗」「在忙吗」这类空话开场。",
].join("");

/**
 * 组装本回合的提示文本。
 *
 * @param {object} params - 参数
 * @param {string} [params.instruction] - 用户在设置页填的指令（可空）
 * @param {number} params.maxChars - 字数上限
 * @param {string} [params.phase] - 当前节奏，`active` 时会提示续接
 * @returns {string} 完整提示
 */
export function buildAutoSendPrompt({ instruction, maxChars, phase }) {
  const body = String(instruction ?? "").trim() || DEFAULT_AUTO_SEND_INSTRUCTION;
  const limit = Math.max(10, Number(maxChars) || 120);

  const lines = [body];
  if (phase === "active") {
    lines.push("你刚刚已经发过一条，这条是紧接着的补充，语气可以更随意些。");
  }
  lines.push(
    `硬性要求：只输出要发送的消息正文，不要任何解释、前缀、标题、列表或代码块；`
      + `不超过 ${limit} 字；不要调用任何工具。`,
  );

  return lines.join("\n");
}
