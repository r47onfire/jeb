# bun-typescript-template

Quick template to get started with a TypeScript project using [Bun](https://bun.com) and [pnpm](https://pnpm.io) with Jest-style unit tests, possibly an NPM package, and/or a Github Pages site.

* Source files go in `src/`
* Test files go in `test/`
* Build scripts and helpers go in `scripts/`
* Build artifacts go in `dist/` - gitignore'd
* Website build files go in `docs/` - gitignore'd

Getting started:

1. update the `package.json` fields: name, version, description, repository, keywords, author, license (and update the LICENSE file if license is different)
1. to build: `pnpm build`
1. to test website: `pnpm dev` and open <http://localhost:8000/>

## NPM package

If you want to publish as an NPM package:

1. make sure to remove `"private": true` from `package.json`
1. make the first release manually as normal `npm publish`
1. once it is on NPM, when you make a new version, bump the version in `package.json` and then manually trigger `.github/workflows/publish-package.yaml`
1. if tests fail, it will not publish

If you don't want to publish as an NPM package:

1. delete `.github/workflows/publish-package.yaml`

## website

If you have a website (docs, demo, etc):

1. put your html files in `website/`
1. if there is more than just `index.html`, make sure to list them as entrypoints in `scripts/build-website.ts`
1. there is a custom plugin that allows Markdown in elements that look like `<div markdown="block">markdown here</div>`
1. uncomment the "push" event in `.github/workflows/website.yaml` if you want to automatically rebuild on every push (it is commented to prevent the workflow from instantly failing when you create the new repo from this template)

If you don't have a website:

1. delete the entire `website/` directory
1. delete `.github/workflows/website.yaml`
1. delete `scripts/build-website.ts`
1. possibly merge the two build scripts
1. delete the `build:website`, `clean-docs`, `dev`, `dev:watch`, and `dev:serve` scripts from `package.json`
