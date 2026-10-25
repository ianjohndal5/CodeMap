Next.js protection cases for the CodeMap security lens: route handlers, server actions and
`middleware.ts`. Each handler says in a comment what CodeMap should report. Analyze it alone:

    codemap --frontend fixtures/next-protection --security

It has no `package.json` on purpose, so `codemap fixtures` still finds exactly one Next.js project.
