#!/bin/sh
# One-shot mechanical rename from gmail-mcp to zoho-mail-mcp. Idempotent: a second run changes nothing.
set -eu
cd "$(dirname "$0")/../.."
files() { git ls-files | grep -E '\.(ts|json|jsonc|md|mjs|yml|yaml)$' | grep -v '^companion/native/' ; }
# Order matters: the scoped package name before the bare one, the class before the bare word.
files | xargs sed -i '' \
  -e 's#@gmail-mcp/#@zoho-mail-mcp/#g' \
  -e 's#GmailMcpError#McpError#g' \
  -e 's#gmail-mcp-companion#zoho-mail-mcp-companion#g' \
  -e 's#app\.gmail-mcp\.companion#app.zoho-mail-mcp.companion#g' \
  -e 's#"name": "gmail-mcp"#"name": "zoho-mail-mcp"#g' \
  -e 's#\.gmail-mcp-#.zoho-mail-mcp-#g' \
  -e 's#Downloads/Gmail MCP#Downloads/Mail#g' \
  -e 's#gmail-mcp\.example\.workers\.dev#zoho-mail-mcp.example.workers.dev#g' \
  -e 's#gmail-mcp\\\.example\\\.workers\\\.dev#zoho-mail-mcp\\.example\\.workers\\.dev#g'
# Package directory names stay; the scope in package.json is what resolves.
git mv companion/native companion/native-swift-retired 2>/dev/null || true
echo "rename done"
