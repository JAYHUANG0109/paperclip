import { describe, expect, it } from "vitest";
import { extractInboundMessage, extractMentions } from "../src/chat.js";

// Mentions are the only reliable signal for "who is being addressed" — the
// visible text is just a display name and breaks on duplicates and renames. So
// these pin the shape Google actually sends, in both event formats.
describe("extractMentions", () => {
  const jay = {
    type: "USER_MENTION",
    userMention: {
      type: "MENTION",
      user: { name: "users/111", displayName: "Jay", type: "HUMAN" },
    },
  };
  const iris = {
    type: "USER_MENTION",
    userMention: {
      type: "MENTION",
      user: { name: "users/222", displayName: "Iris", type: "HUMAN" },
    },
  };
  const bot = {
    type: "USER_MENTION",
    userMention: {
      type: "ADD",
      user: { name: "users/999", displayName: "SeasonartsAI", type: "BOT" },
    },
  };

  it("returns the mentioned people", () => {
    expect(extractMentions({ annotations: [jay] })).toEqual([
      { userName: "users/111", displayName: "Jay" },
    ]);
  });

  it("keeps every distinct person, in order", () => {
    expect(extractMentions({ annotations: [jay, iris] }).map((m) => m.userName)).toEqual([
      "users/111",
      "users/222",
    ]);
  });

  // Every message to a bot in a space carries the bot's own mention; treating it
  // as a person would redirect every message away from the sender's agent.
  it("drops the bot's own mention", () => {
    expect(extractMentions({ annotations: [bot] })).toEqual([]);
    expect(extractMentions({ annotations: [bot, jay] }).map((m) => m.userName)).toEqual([
      "users/111",
    ]);
  });

  it("de-duplicates a person mentioned twice", () => {
    expect(extractMentions({ annotations: [jay, jay] })).toHaveLength(1);
  });

  it("ignores non-mention annotations and malformed entries", () => {
    const slash = { type: "SLASH_COMMAND", slashCommand: { commandName: "/tasks" } };
    expect(extractMentions({ annotations: [slash] })).toEqual([]);
    expect(extractMentions({ annotations: [null, {}, { type: "USER_MENTION" }] })).toEqual([]);
  });

  it("returns nothing when the message has no annotations", () => {
    expect(extractMentions({})).toEqual([]);
    expect(extractMentions({ annotations: "not-an-array" })).toEqual([]);
  });
});

describe("extractInboundMessage carries mentions", () => {
  const annotations = [
    {
      type: "USER_MENTION",
      userMention: { user: { name: "users/111", displayName: "Jay", type: "HUMAN" } },
    },
  ];

  it("parses mentions from the classic Chat event format", () => {
    const inbound = extractInboundMessage({
      type: "MESSAGE",
      space: { name: "spaces/AAA", type: "ROOM", displayName: "領導團隊" },
      message: {
        name: "spaces/AAA/messages/1",
        text: "@Jay 幫我看一下 X",
        sender: { email: "founder@seasonart.org", name: "users/555" },
        annotations,
      },
    });
    expect(inbound?.mentions).toEqual([{ userName: "users/111", displayName: "Jay" }]);
    expect(inbound?.spaceType).toBe("ROOM");
  });

  it("parses mentions from the Workspace add-on event format", () => {
    const inbound = extractInboundMessage({
      chat: {
        messagePayload: {
          space: { name: "spaces/BBB", type: "ROOM" },
          message: {
            name: "spaces/BBB/messages/2",
            text: "@Jay ping",
            sender: { email: "founder@seasonart.org", name: "users/555" },
            annotations,
          },
        },
      },
    });
    expect(inbound?.mentions).toEqual([{ userName: "users/111", displayName: "Jay" }]);
  });

  it("leaves mentions empty for an ordinary message", () => {
    const inbound = extractInboundMessage({
      type: "MESSAGE",
      space: { name: "spaces/AAA", type: "DM" },
      message: {
        name: "spaces/AAA/messages/3",
        text: "hello",
        sender: { email: "founder@seasonart.org", name: "users/555" },
      },
    });
    expect(inbound?.mentions).toEqual([]);
  });
});
