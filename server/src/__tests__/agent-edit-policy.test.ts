import { describe, expect, it } from "vitest";
import {
  isItDepartmentEditor,
  isProtectedAgent,
  itEditorMayEditAgent,
} from "../services/agent-edit-policy.js";

const FOUNDER = "593fa24b-96dd-4c76-aca1-44ea8dd784ac";
const HUIJUN = "08c1ba71-698a-4839-81cd-bd0f2dadaf4e";
const JAY = "7e1a0853-38f2-4a2f-ac5b-69247c1a350c";
const SOME_AGENT = "11111111-1111-4111-8111-111111111111";

describe("isItDepartmentEditor", () => {
  it("recognizes allowlisted 資訊部 users (case-insensitive)", () => {
    expect(isItDepartmentEditor({ email: "a0000960@seasonart.org" })).toBe(true);
    expect(isItDepartmentEditor({ email: "A0001186@SEASONART.ORG" })).toBe(true);
    expect(isItDepartmentEditor({ email: "it-jessica@seasonart.org" })).toBe(true);
  });
  it("recognizes 資訊部 team members (option 3)", () => {
    expect(isItDepartmentEditor({ email: "someone@x.org", teams: ["資訊部"] })).toBe(true);
    expect(isItDepartmentEditor({ teams: ["IT"] })).toBe(true);
  });
  it("rejects everyone else", () => {
    expect(isItDepartmentEditor({ email: "tang@seasonart.org" })).toBe(false);
    expect(isItDepartmentEditor({ email: "random@seasonart.org", teams: ["教學部"] })).toBe(false);
    expect(isItDepartmentEditor({})).toBe(false);
  });
});

describe("isProtectedAgent", () => {
  it("protects the admin tier by agent id (incl. Jay, who has no owner email)", () => {
    expect(isProtectedAgent({ agentId: FOUNDER })).toBe(true);
    expect(isProtectedAgent({ agentId: HUIJUN })).toBe(true);
    expect(isProtectedAgent({ agentId: JAY, ownerEmail: null })).toBe(true);
  });
  it("also protects by owner email (founder/惠君)", () => {
    expect(isProtectedAgent({ agentId: SOME_AGENT, ownerEmail: "tang@seasonart.org" })).toBe(true);
    expect(isProtectedAgent({ agentId: SOME_AGENT, ownerEmail: "betty1@seasonart.org" })).toBe(true);
  });
  it("does not protect ordinary agents", () => {
    expect(isProtectedAgent({ agentId: SOME_AGENT, ownerEmail: "a0000960@seasonart.org" })).toBe(false);
    expect(isProtectedAgent({ agentId: SOME_AGENT })).toBe(false);
  });
});

describe("itEditorMayEditAgent", () => {
  it("a 資訊部 editor may edit an ordinary agent", () => {
    expect(itEditorMayEditAgent({ email: "a0000960@seasonart.org" }, { agentId: SOME_AGENT })).toBe(true);
  });
  it("a 資訊部 editor may NOT edit the founder, 惠君, or Jay", () => {
    const it = { email: "a0000960@seasonart.org" };
    expect(itEditorMayEditAgent(it, { agentId: FOUNDER })).toBe(false);
    expect(itEditorMayEditAgent(it, { agentId: HUIJUN })).toBe(false);
    expect(itEditorMayEditAgent(it, { agentId: JAY })).toBe(false);
    expect(itEditorMayEditAgent(it, { agentId: SOME_AGENT, ownerEmail: "tang@seasonart.org" })).toBe(false);
  });
  it("a non-資訊部 user is not granted by this policy (falls through to other rules)", () => {
    expect(itEditorMayEditAgent({ email: "random@seasonart.org" }, { agentId: SOME_AGENT })).toBe(false);
  });
});
