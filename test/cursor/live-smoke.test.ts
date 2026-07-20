import { expect, it } from "vitest";
import { CursorAcpClient, findCursorModelOption } from "#src/cursor/acp-client";
import { discoverCursorModels } from "#src/cursor/discover-cursor-models";
import { ListSubagentModelsTool } from "#src/tools/list-subagent-models-tool";

const live = process.env.CURSOR_ACP_LIVE === "1" ? it : it.skip;

live("prompts the installed Cursor CLI over ACP", { timeout: 120_000 }, async () => {
  let output = "";
  const client = new CursorAcpClient({
    requestTimeoutMs: 30_000,
    onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    onUpdate(notification) {
      const update = notification.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        output += update.content.text;
      }
    },
  });
  try {
    const started = await client.start({
      cwd: process.cwd(),
    });
    expect(findCursorModelOption(started.configOptions)).toBeDefined();
		const option = findCursorModelOption(started.configOptions);
		expect(option?.type).toBe("select");
		if (option?.type === "select") expect(started.modelIdentity?.value).toBe(option.currentValue);
    const result = await client.prompt("Reply exactly CURSOR_ACP_SMOKE_OK. Do not use tools.");
    expect(result.stopReason).toBe("end_turn");
    expect(output).toContain("CURSOR_ACP_SMOKE_OK");
  } finally {
    await client.close();
  }
});

live("discovers live Cursor ACP values and keeps model output compact", { timeout: 120_000 }, async () => {
  const models = await discoverCursorModels({ cwd: process.cwd() });

  expect(models.length).toBeGreaterThan(0);
  expect(models.some((model) => model.value.length > 0 && model.name.length > 0)).toBe(true);

	// Reuse the one live discovery result so this smoke verifies formatting without
	// opening multiple extra ACP sessions (which can trigger Cursor startup throttling).
	const tool = new ListSubagentModelsTool({ discoverCursorModels: async () => models });
	const ctx = { cwd: process.cwd(), modelRegistry: undefined } as never;
	const browse = await tool.execute({ backend: "cursor" }, undefined, ctx);
	const browseText = browse.content[0]?.text ?? "";
	const current = browse.details?.cursor?.models.find((model) => model.current)
		?? browse.details?.cursor?.models[0];

	expect(current).toBeDefined();
	expect(browseText.length).toBeLessThan(1_500);
	for (const model of browse.details?.cursor?.models ?? []) {
		if (model.value !== model.name) expect(browseText).not.toContain(model.value);
	}

	const lookup = await tool.execute({ backend: "cursor", query: current!.name }, undefined, ctx);
	const lookupText = lookup.content[0]?.text ?? "";
	expect(lookupText).toContain(current!.value);
	expect(lookupText.match(/subagent\(/g)).toHaveLength(1);
});
