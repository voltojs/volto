import { describe, it, expect } from "vitest";
import { createChatAdapter } from "../index.js";
import type { ChatPlatform } from "../index.js";

function createMockPlatform(): ChatPlatform & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    async sendMessage(_channelId: string, text: string) {
      messages.push(text);
    },
    async editMessage(_channelId: string, _messageId: string, text: string) {
      messages[messages.length - 1] = text;
    },
  };
}

describe("Chat adapter", () => {
  it("createChatAdapter returns adapter with handleMessage", () => {
    const platform = createMockPlatform();
    const adapter = createChatAdapter(platform);
    expect(typeof adapter.handleMessage).toBe("function");
  });
});
