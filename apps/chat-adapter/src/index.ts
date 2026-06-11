/**
 * Chat adapter — converts headless server events to chat-friendly messages.
 * Works with Slack, Discord, or any chat platform via a simple adapter interface.
 */

interface AgentEvent {
  type: "text_delta" | "tool_result" | "model_done" | "error" | "done";
  data: Record<string, unknown>;
}

export interface ChatPlatform {
  sendMessage(channelId: string, text: string): Promise<void>;
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;
}

export interface ChatAdapterOptions {
  serverUrl?: string;
}

export interface ChatAdapter {
  handleMessage(channelId: string, message: string): Promise<void>;
}

export function createChatAdapter(
  platform: ChatPlatform,
  opts: ChatAdapterOptions = {},
): ChatAdapter {
  const serverUrl = opts.serverUrl ?? "http://localhost:3100";

  return {
    async handleMessage(channelId: string, message: string): Promise<void> {
      const url = new URL("/stream", serverUrl);
      url.searchParams.set("message", message);
      const response = await fetch(url.toString());
      const reader = response.body?.getReader();
      if (!reader) {
        await platform.sendMessage(channelId, "Error: Could not connect to agent");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedText = "";
      let messageId: string | undefined;
      let done = false;

      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          const event = JSON.parse(data) as AgentEvent;
          if (event.type === "text_delta" && typeof event.data["text"] === "string") {
            accumulatedText += event.data["text"];
            if (messageId) {
              await platform.editMessage(channelId, messageId, accumulatedText);
            } else {
              messageId = await sendMessage(platform, channelId, accumulatedText);
            }
          }
        }
      }

      if (!messageId && accumulatedText) {
        await platform.sendMessage(channelId, accumulatedText);
      }
    },
  };
}

async function sendMessage(
  platform: ChatPlatform,
  channelId: string,
  text: string,
): Promise<string> {
  // In real implementation, this would return the platform's message ID
  await platform.sendMessage(channelId, text);
  return "msg-placeholder";
}
