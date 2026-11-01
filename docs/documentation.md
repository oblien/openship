# Maintaining the documentation

Website content lives in `apps/web/content/docs`. `meta.json` files define the
navigation order. Keep pages organized by the reader's task.

## One reference per resource

`api/<resource>.mdx` owns the behavior, inputs, results, and examples for a resource.
Use **SDK / REST API** code tabs on that page. Explain fields once, outside the
tabs. SDK setup, identity, and lifecycle guides live in `api/sdk`; do not add a
parallel SDK resource reference there.

Use the same tab settings so the reader's choice is shared and remembered:

```mdx
<Tabs items={['SDK', 'REST API']} groupId="api-transport" persist>
<Tab value="SDK">

...SDK code block...

</Tab>
<Tab value="REST API">

...equivalent HTTP code block...

</Tab>
</Tabs>
```

State when an endpoint has no named native operation. A remote client's generic
HTTP transport does not establish native support. Keep release and provider limits
in `api/sdk/compatibility.mdx` and link to the relevant section.

## Updating reference catalogs

Build the public package after SDK or CLI changes, then update and check the docs:

```sh
bun run build:sdk
bun run docs:reference
bun run docs:check
bun run --cwd apps/web build
```

- `scripts/docs-api-reference.json` contains each operation's description and
  canonical resource page. `docs:reference` reads SDK signatures and API routes
  from source and updates only the marked operation tables. Every SDK method and
  concrete route has one owner. Better Auth's vendor routes are represented by
  the mounted catch-all and explained on the authentication page.
- CLI reference pages come from the **built public CLI's help**, including command
  arguments and options. Edit command help in its source, then regenerate.
- Workflow guides contain examples and link to these reference pages. Do not copy
  full command-option lists into guides.

`docs:check` compiles MDX, checks navigation and internal links, verifies catalog
coverage, compares CLI reference text and example commands with command help, and type-checks SDK
examples against the public package declarations. SDK resource snippets use `ship`
for an existing client/scope; setup examples must include their own configuration.

The Documentation CI job runs those checks and builds the website. Type-checking
an example checks its public interface; it does not execute a provider workflow.
The installed-package lifecycle example and provider integration tests remain
separate runtime checks.
