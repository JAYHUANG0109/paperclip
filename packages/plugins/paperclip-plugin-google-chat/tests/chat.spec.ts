import { describe, expect, it } from "vitest";
import { splitFirstImage, sendMessage } from "../src/chat.js";

describe("splitFirstImage", () => {
  it("returns the text unchanged when there is no image", () => {
    const md = "Just some **text** with a https://example.com link.";
    expect(splitFirstImage(md)).toEqual({ text: md });
  });

  it("extracts the first image url + alt and strips image markdown from text", () => {
    const md = "請完成設定:\n\n![Asana 設定步驟](https://host/img.png)\n\n完成後貼回權杖。";
    const out = splitFirstImage(md);
    expect(out.imageUrl).toBe("https://host/img.png");
    expect(out.imageAltText).toBe("Asana 設定步驟");
    expect(out.text).not.toContain("![");
    expect(out.text).toContain("請完成設定");
    expect(out.text).toContain("完成後貼回權杖");
  });

  it("defaults alt text to 'image' when the markdown alt is empty", () => {
    expect(splitFirstImage("![](https://host/x.png)").imageAltText).toBe("image");
  });

  it("ignores non-http(s) image urls", () => {
    const md = "![local](./relative.png)";
    expect(splitFirstImage(md)).toEqual({ text: md });
  });
});

describe("sendMessage body", () => {
  function captureBody(): {
    fetchImpl: (url: string, init?: any) => Promise<Response>;
    sent: () => any;
  } {
    let captured: any;
    const fetchImpl = async (_url: string, init?: any) => {
      captured = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    };
    return { fetchImpl, sent: () => captured };
  }

  it("sends a text-only body when no image is given", async () => {
    const cap = captureBody();
    await sendMessage(cap.fetchImpl, "tok", { spaceName: "spaces/A", text: "hi" });
    expect(cap.sent()).toEqual({ text: "hi" });
  });

  it("sends text + a cardsV2 image widget when imageUrl is given", async () => {
    const cap = captureBody();
    await sendMessage(cap.fetchImpl, "tok", {
      spaceName: "spaces/A",
      text: "steps",
      imageUrl: "https://host/img.png",
      imageAltText: "diagram"
    });
    const body = cap.sent();
    expect(body.text).toBe("steps");
    expect(body.cardsV2[0].card.sections[0].widgets[0].image).toEqual({
      imageUrl: "https://host/img.png",
      altText: "diagram",
      onClick: { openLink: { url: "https://host/img.png" } }
    });
  });
});
