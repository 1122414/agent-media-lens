import {readFileSync} from "node:fs";
import assert from "node:assert/strict";
const root=new URL("../plugins/codex/",import.meta.url);
const read=(path)=>readFileSync(new URL(path,root),"utf8");
const manifest=JSON.parse(read(".codex-plugin/plugin.json"));
const market=JSON.parse(read("../../.agents/plugins/marketplace.json"));
assert.equal(market.plugins[0].source.path,"./plugins/codex");
assert.equal(market.plugins[0].name,manifest.name);
assert.equal(manifest.version,JSON.parse(read("../../package.json")).version);
const server=JSON.parse(read(manifest.mcpServers)).mcpServers[manifest.name];
assert.equal(server.command,"sh");
assert.match(server.args[1],/exec media-lens-mcp/);
assert.match(server.args[1],/\$HOME\/\.local\/bin\/media-lens-mcp/);
for (const path of ["../../pyproject.toml", "../../uv.lock"]) {
  assert.ok(read(path).includes('name = "agent-media-lens-worker"\nversion = "' + manifest.version + '"'), path + " version mismatch");
}
assert.match(read(manifest.skills+"media-understanding/SKILL.md"),/^---\nname: media-understanding\ndescription: [^\n]+\n---/);
for (const ref of ["analysis-template.md", "creative-study.md"]) read("skills/media-understanding/references/" + ref);
console.log("Plugin manifest, marketplace, skill references and MCP launcher agree.");
