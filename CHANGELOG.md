# Changelog

## [3.5.0](https://github.com/Miragon/bpm-iq/compare/v3.4.0...v3.5.0) (2026-08-17)


### Features

* **web:** the Miragon comet in the header, the widget toolbars and the favicon ([#97](https://github.com/Miragon/bpm-iq/issues/97)) ([8828d57](https://github.com/Miragon/bpm-iq/commit/8828d579e9afc69edb0950e4ebcce2bd9732cc4d))

## [3.4.0](https://github.com/Miragon/bpm-iq/compare/v3.3.0...v3.4.0) (2026-08-17)


### Features

* dedup L-tier — the ModelKind collapse, and repos that count decisions ([#95](https://github.com/Miragon/bpm-iq/issues/95)) ([789a349](https://github.com/Miragon/bpm-iq/commit/789a3494cc9124fe51fc910c1c2cbf34ea5a23a5))


### Bug Fixes

* dedup M-tier (2) — trusted-anchor todos, widget save-button latch, tracker vocabulary, panel rule ([#90](https://github.com/Miragon/bpm-iq/issues/90)) ([695b3ce](https://github.com/Miragon/bpm-iq/commit/695b3ce2cc7cbd4a52896cd123eaf730553f69fb))
* **live-host,web:** close the three review findings on the ModelKind collapse ([#95](https://github.com/Miragon/bpm-iq/issues/95)) ([#96](https://github.com/Miragon/bpm-iq/issues/96)) ([270ee21](https://github.com/Miragon/bpm-iq/commit/270ee2130a114ed3525c2a763f003c780b3bda2c))

## [3.3.0](https://github.com/Miragon/bpm-iq/compare/v3.2.0...v3.3.0) (2026-08-15)


### Features

* dedup M-tier — mcp-kit, tool factories, discovery resolution, MCP audit trail, shared web view-models ([#89](https://github.com/Miragon/bpm-iq/issues/89)) ([93c0b49](https://github.com/Miragon/bpm-iq/commit/93c0b49a5ab8844657a8b8a2938815897d7db345))
* simulate, analyse and test DMN decisions ([#83](https://github.com/Miragon/bpm-iq/issues/83)) ([2f2b825](https://github.com/Miragon/bpm-iq/commit/2f2b825ec56ee2e485dce82a378915a25d768ca7))


### Bug Fixes

* dedup S-tier — dead-on-arrival live-host image, MCP entry hardening, decision-link integrity ([#88](https://github.com/Miragon/bpm-iq/issues/88)) ([a69f13c](https://github.com/Miragon/bpm-iq/commit/a69f13cc46fb3b28373dd79401284322fd0a10ff))

## [3.2.0](https://github.com/Miragon/bpm-iq/compare/v3.1.0...v3.2.0) (2026-08-05)


### Features

* **live-host:** embedded BPMN modeler as an MCP App, and a resource server exact-match clients can reach ([#76](https://github.com/Miragon/bpm-iq/issues/76)) ([a2f4877](https://github.com/Miragon/bpm-iq/commit/a2f487767a458bbea5952f2053f615a2552b7154))
* **live-host:** live co-editing in the MCP-App modeler via single-use ws tickets ([#79](https://github.com/Miragon/bpm-iq/issues/79)) ([20fd8d5](https://github.com/Miragon/bpm-iq/commit/20fd8d53a1c4e26e36fe3344047e53399e2fbfff))
* **live-host:** todos as MCP tools and a todo panel in the modeler widget ([#80](https://github.com/Miragon/bpm-iq/issues/80)) ([3e6054f](https://github.com/Miragon/bpm-iq/commit/3e6054f224484548935cc86cb10f07f3376f3605))

## [3.1.0](https://github.com/Miragon/bpm-iq/compare/v3.0.1...v3.1.0) (2026-07-29)


### Features

* **live-host:** cross-tenant OIDC login asks the platform to rescope to THIS tenant ([#71](https://github.com/Miragon/bpm-iq/issues/71)) ([3f7fa05](https://github.com/Miragon/bpm-iq/commit/3f7fa05fcabf362b6bb32d43841d9d3359d3148e))


### Bug Fixes

* **build:** copy live-client into the runtime stage too — the install-layer fix alone left a dangling symlink ([#70](https://github.com/Miragon/bpm-iq/issues/70)) ([a4c6564](https://github.com/Miragon/bpm-iq/commit/a4c65648535192dc3c94d3ad205a94921cddba3d))
* **build:** live-client manifest missing from the image install layer ([#68](https://github.com/Miragon/bpm-iq/issues/68)) ([84ecac8](https://github.com/Miragon/bpm-iq/commit/84ecac87292426ea8f09eed90ca9fea249bcd72f))

## [3.0.1](https://github.com/Miragon/bpm-iq/compare/v3.0.0...v3.0.1) (2026-07-28)


### Bug Fixes

* **build:** install Corepack explicitly on Node 26 base image ([#66](https://github.com/Miragon/bpm-iq/issues/66)) ([553dab9](https://github.com/Miragon/bpm-iq/commit/553dab966a44e76dfe07bb1a6ee73ad37feccb4f))

## [3.0.0](https://github.com/Miragon/bpm-iq/compare/v2.3.0...v3.0.0) (2026-07-28)


### ⚠ BREAKING CHANGES

* **live-host:** HANDOFF_SECRET and POST /auth/handoff no longer exist; cell deployments authenticate browsers via LIVE_OIDC_CLIENT_ID (browser SSO).

### Features

* **live-host:** browser SSO — interactive OIDC login on the resource-server contract ([#64](https://github.com/Miragon/bpm-iq/issues/64)) ([b88d48f](https://github.com/Miragon/bpm-iq/commit/b88d48f0289bb6989665113a3ac43e4491a8b08a))
* **live-host:** enforce the tenant claim on OIDC tokens in cell mode ([#63](https://github.com/Miragon/bpm-iq/issues/63)) ([948e9d3](https://github.com/Miragon/bpm-iq/commit/948e9d352f04d2aa3c4ece2a45771a7ce831beb4))
* **live-host:** in-process /mcp, REST content routes, OIDC resource-server auth ([#60](https://github.com/Miragon/bpm-iq/issues/60)) ([c4c91f4](https://github.com/Miragon/bpm-iq/commit/c4c91f4bcc8b7c23da2ce68c574f5d9a83d7c265))


### Code Refactoring

* **live-host:** remove the handoff login — cells authenticate browsers via OIDC ([#65](https://github.com/Miragon/bpm-iq/issues/65)) ([46bfdb5](https://github.com/Miragon/bpm-iq/commit/46bfdb5953bd0523988e57b3057e11106d75bc63))

## [2.3.0](https://github.com/Miragon/bpm-iq/compare/v2.2.0...v2.3.0) (2026-07-17)


### Features

* hide create/release actions when a repo has no bpmiq.yml ([#53](https://github.com/Miragon/bpm-iq/issues/53)) ([34546dd](https://github.com/Miragon/bpm-iq/commit/34546dd67f85a1655681ac8cca03b42ea4b7d98f))
* visual dmn-js editor for .dmn artifacts in the web client ([#51](https://github.com/Miragon/bpm-iq/issues/51)) ([d31ce72](https://github.com/Miragon/bpm-iq/commit/d31ce728b1ac33eab97abdc524ab9b45c9b987ec))

## [2.2.0](https://github.com/Miragon/bpm-iq/compare/v2.1.0...v2.2.0) (2026-07-17)


### Features

* folder tree, create-folder and create-process in the repository view ([#50](https://github.com/Miragon/bpm-iq/issues/50)) ([d61b466](https://github.com/Miragon/bpm-iq/commit/d61b466dc536090b78fd1005f55d430d793b0881))
* load latest from main in the repository view ([#48](https://github.com/Miragon/bpm-iq/issues/48)) ([67310d8](https://github.com/Miragon/bpm-iq/commit/67310d89b72eb929364371cbfc8533d09848a8cb))

## [2.1.0](https://github.com/Miragon/bpm-iq/compare/v2.0.0...v2.1.0) (2026-07-17)


### Features

* **web:** show a repository's processes as a sortable table ([#42](https://github.com/Miragon/bpm-iq/issues/42)) ([70d185e](https://github.com/Miragon/bpm-iq/commit/70d185eaa101b87c36e4508a2c7133f193d099d2))


### Bug Fixes

* authenticate the release upstream-guard fetch ([#41](https://github.com/Miragon/bpm-iq/issues/41)) ([219a716](https://github.com/Miragon/bpm-iq/commit/219a716cbffdc8352092b6a6d617ecd595b5c911))
* **web:** pin @tanstack/react-table to an exact version ([#47](https://github.com/Miragon/bpm-iq/issues/47)) ([f1f6bf4](https://github.com/Miragon/bpm-iq/commit/f1f6bf44e7ba99a10131056d1abde161e74de896))

## [2.0.0](https://github.com/Miragon/bpm-iq/compare/v1.0.0...v2.0.0) (2026-07-17)


### ⚠ BREAKING CHANGES

* minimal bpmiq.yml content contract + slim platform ([#36](https://github.com/Miragon/bpm-iq/issues/36))

### Features

* file history panel — compare & restore against the default branch ([#37](https://github.com/Miragon/bpm-iq/issues/37)) ([2cab2c2](https://github.com/Miragon/bpm-iq/commit/2cab2c26fc6c0138cf6bd001fa4baaefe21ab99f))
* minimal bpmiq.yml content contract + slim platform ([#36](https://github.com/Miragon/bpm-iq/issues/36)) ([2fbb4c2](https://github.com/Miragon/bpm-iq/commit/2fbb4c264eccc0e10163b6fc783c9a43f6aa246b))
* model-anchored todos as issues in the customer's tracker ([#26](https://github.com/Miragon/bpm-iq/issues/26)) ([cd3c07c](https://github.com/Miragon/bpm-iq/commit/cd3c07c742b94cf54a605a35af17569b1d53fefe))
* todos phase 2 — deep links, close from canvas, manual form, MCP tool ([#27](https://github.com/Miragon/bpm-iq/issues/27)) ([22f90f4](https://github.com/Miragon/bpm-iq/commit/22f90f4eb3a79d341843426b1e50c29c66c41010))
* **web:** subtle design.miragon.ai link in the header ([#30](https://github.com/Miragon/bpm-iq/issues/30)) ([8a39783](https://github.com/Miragon/bpm-iq/commit/8a39783a3ad8306df6fb05dd82d2a35aa6a25462))


### Bug Fixes

* drop stale process-documentation manifest from the image build ([#39](https://github.com/Miragon/bpm-iq/issues/39)) ([2de15f3](https://github.com/Miragon/bpm-iq/commit/2de15f38a2965017a33f9d7d25486e60820e606e))

## [1.0.0](https://github.com/Miragon/bpm-iq/compare/bpmiq-v0.2.0...bpmiq-v1.0.0) (2026-07-17)


### ⚠ BREAKING CHANGES

* minimal bpmiq.yml content contract + slim platform ([#36](https://github.com/Miragon/bpm-iq/issues/36))

### Features

* file history panel — compare & restore against the default branch ([#37](https://github.com/Miragon/bpm-iq/issues/37)) ([2cab2c2](https://github.com/Miragon/bpm-iq/commit/2cab2c26fc6c0138cf6bd001fa4baaefe21ab99f))
* minimal bpmiq.yml content contract + slim platform ([#36](https://github.com/Miragon/bpm-iq/issues/36)) ([2fbb4c2](https://github.com/Miragon/bpm-iq/commit/2fbb4c264eccc0e10163b6fc783c9a43f6aa246b))
* **web:** subtle design.miragon.ai link in the header ([#30](https://github.com/Miragon/bpm-iq/issues/30)) ([8a39783](https://github.com/Miragon/bpm-iq/commit/8a39783a3ad8306df6fb05dd82d2a35aa6a25462))

## [0.2.0](https://github.com/Miragon/bpm-iq/compare/bpmiq-v0.1.0...bpmiq-v0.2.0) (2026-07-16)


### Features

* model-anchored todos as issues in the customer's tracker ([#26](https://github.com/Miragon/bpm-iq/issues/26)) ([cd3c07c](https://github.com/Miragon/bpm-iq/commit/cd3c07c742b94cf54a605a35af17569b1d53fefe))
* todos phase 2 — deep links, close from canvas, manual form, MCP tool ([#27](https://github.com/Miragon/bpm-iq/issues/27)) ([22f90f4](https://github.com/Miragon/bpm-iq/commit/22f90f4eb3a79d341843426b1e50c29c66c41010))
