# Changelog

## [3.10.0](https://github.com/Miragon/bpm-iq/compare/v3.9.0...v3.10.0) (2026-09-04)


### Features

* **live-host:** generic MCP model tools for ANY notation — get/save content, create, validate, ws ticket ([#160](https://github.com/Miragon/bpm-iq/issues/160)) ([9b797ad](https://github.com/Miragon/bpm-iq/commit/9b797ad4e476f66b7af6d2ed3cad3f0b9c7bee03))
* **notations,live-client,web:** mount the Miragon context-maps modeler as an editor plugin ([#162](https://github.com/Miragon/bpm-iq/issues/162)) ([e5a68a9](https://github.com/Miragon/bpm-iq/commit/e5a68a9a881390334bb4738b34696c4ba2b9620b))
* **web,live-host:** MCP-App widget core — one lifecycle, per-notation widgets, generated open_&lt;notation&gt;_modeler tools ([#156](https://github.com/Miragon/bpm-iq/issues/156)) ([#163](https://github.com/Miragon/bpm-iq/issues/163)) ([241dbc5](https://github.com/Miragon/bpm-iq/commit/241dbc5db1af6e1b0c81927c5d3aa85cbd3fe372))
* **web,live-host:** the Context Map modeler widget — open_context_map_modeler on the widget core ([#164](https://github.com/Miragon/bpm-iq/issues/164)) ([d098e01](https://github.com/Miragon/bpm-iq/commit/d098e013ee79200feca53fe7e7b85471162812e3))

## [3.9.0](https://github.com/Miragon/bpm-iq/compare/v3.8.0...v3.9.0) (2026-09-04)


### Features

* **notations,live-client,web:** mount the Miragon event-storming modeler as an editor plugin ([#152](https://github.com/Miragon/bpm-iq/issues/152)) ([1e53dc9](https://github.com/Miragon/bpm-iq/commit/1e53dc9a0bce063641eeb5e508863728e22464fc))
* **web:** redesign the editor toolbar — grouped chrome, overflow menu, Design mode ([#144](https://github.com/Miragon/bpm-iq/issues/144)) ([9c75a49](https://github.com/Miragon/bpm-iq/commit/9c75a49f08502e04f3cbb02da57ad2a7054182e3))


### Bug Fixes

* **web:** don't surface transient ws drops as a dead live document ([#147](https://github.com/Miragon/bpm-iq/issues/147)) ([076b632](https://github.com/Miragon/bpm-iq/commit/076b632a0930f1c4709a0353fd2e47cc85fb87b8))
* **web:** keep the Design switch's knob inside its track ([#148](https://github.com/Miragon/bpm-iq/issues/148)) ([965c0d1](https://github.com/Miragon/bpm-iq/commit/965c0d1f8206e45c0dcfe079676083231f5183ee))
* **web:** scope vendor CSS onto the renderer root, not below it ([#146](https://github.com/Miragon/bpm-iq/issues/146)) ([0f99fe6](https://github.com/Miragon/bpm-iq/commit/0f99fe6d25cf5b44efd8270293dc04d6339e5b9a))

## [3.8.0](https://github.com/Miragon/bpm-iq/compare/v3.7.0...v3.8.0) (2026-08-27)


### Features

* bpmiq:sticky — the t.BPM discussion layer on the BPMN canvas ([#117](https://github.com/Miragon/bpm-iq/issues/117)) ([#141](https://github.com/Miragon/bpm-iq/issues/141)) ([ee77534](https://github.com/Miragon/bpm-iq/commit/ee775347f08b5464205a91c4d9c5b921af2cf133))
* **contracts,live-client,web,live-host:** live canvas cursors + presence ([#115](https://github.com/Miragon/bpm-iq/issues/115)) ([#138](https://github.com/Miragon/bpm-iq/issues/138)) ([0312b48](https://github.com/Miragon/bpm-iq/commit/0312b489a184ba7cfbf02dd6d436e49f9e4b3793))
* **contracts,notations,live-client,live-host,web:** the structured live-doc shape — dark launch ([#137](https://github.com/Miragon/bpm-iq/issues/137)) ([40e76ae](https://github.com/Miragon/bpm-iq/commit/40e76ae8960c5a34e4e2f831891e3c94d9ed64fa))
* cross-notation reference meta-model — typed refs, RepoIndex, one dangling rule, ruleIds ([#122](https://github.com/Miragon/bpm-iq/issues/122)) ([#132](https://github.com/Miragon/bpm-iq/issues/132)) ([d1d7bcc](https://github.com/Miragon/bpm-iq/commit/d1d7bcc6c76683c9379a42993664c3016afd923e))
* **mcp,live-host,notations:** registry-driven MCP tools — get_view, graphHints graph analyses, contribution hooks ([#133](https://github.com/Miragon/bpm-iq/issues/133)) ([b1ff979](https://github.com/Miragon/bpm-iq/commit/b1ff9796542efb271acf09df66855bde98cec97c))
* **notations,contracts,live-host,web:** create models of ANY notation from the platform ([#139](https://github.com/Miragon/bpm-iq/issues/139)) ([#140](https://github.com/Miragon/bpm-iq/issues/140)) ([a202f18](https://github.com/Miragon/bpm-iq/commit/a202f1890c50ccb3fd469573aff4601277ad0fc3))
* **notations,validator,live-host,mcp:** capability slots — data descriptor, deriveView/templateFor dispatch, one checkModel ([#131](https://github.com/Miragon/bpm-iq/issues/131)) ([fee9da0](https://github.com/Miragon/bpm-iq/commit/fee9da0f287cbd3e02165213c5bf8792321e90f3))
* **notations,validator,live-host,web:** registry-driven discovery — every notation becomes visible ([#129](https://github.com/Miragon/bpm-iq/issues/129)) ([511cbb0](https://github.com/Miragon/bpm-iq/commit/511cbb0c730631e2e309ea0cedbb8d4291f01e2d))
* **web,contracts:** editor plugin registry — lazy per-notation engines replace the isBpmn/isDmn branches ([#134](https://github.com/Miragon/bpm-iq/issues/134)) ([b5fde28](https://github.com/Miragon/bpm-iq/commit/b5fde28290452e1eafa71b2db6ca737bfd4f9a8b))
* **web,live-client:** mount the Miragon wardley + team-topologies modelers as editor plugins ([#135](https://github.com/Miragon/bpm-iq/issues/135)) ([eb00784](https://github.com/Miragon/bpm-iq/commit/eb007849727910dd320eb108012ff29141ea5a60))
* **web:** the t.BPM workshop mode — reduced suitcase palette + moderation panel ([#54](https://github.com/Miragon/bpm-iq/issues/54)) ([#142](https://github.com/Miragon/bpm-iq/issues/142)) ([1482269](https://github.com/Miragon/bpm-iq/commit/148226994da2517947052e8eb707bb2c4e7c0607))

## [3.7.0](https://github.com/Miragon/bpm-iq/compare/v3.6.0...v3.7.0) (2026-08-19)


### Features

* **web,live-host:** "Open in bpmiq" — deep-link a widget model into the web modeler ([#106](https://github.com/Miragon/bpm-iq/issues/106)) ([ecb01fd](https://github.com/Miragon/bpm-iq/commit/ecb01fd17ba0c64861fead9c30d3e8b3cb878d7f))


### Bug Fixes

* **live-host:** persist seeds eagerly and flush on SIGHUP so re-seeded live docs cannot duplicate ([#107](https://github.com/Miragon/bpm-iq/issues/107)) ([94b77ff](https://github.com/Miragon/bpm-iq/commit/94b77ff7ce4e384bdd6430e25dadde0be2ada812)), closes [#103](https://github.com/Miragon/bpm-iq/issues/103)

## [3.6.0](https://github.com/Miragon/bpm-iq/compare/v3.5.1...v3.6.0) (2026-08-19)


### Features

* **web:** "Analyse with AI" — deep-link a model into a Claude or ChatGPT chat ([#104](https://github.com/Miragon/bpm-iq/issues/104)) ([8977ae1](https://github.com/Miragon/bpm-iq/commit/8977ae18742ce7244feb1ceab4e6ec7c4ba3ed4e))


### Bug Fixes

* **web:** every decision-table input is optional, and the table gets an inset ([#101](https://github.com/Miragon/bpm-iq/issues/101)) ([2cf94e1](https://github.com/Miragon/bpm-iq/commit/2cf94e155bdbf5eaf50a72fc002a3bb163c908ab))

## [3.5.1](https://github.com/Miragon/bpm-iq/compare/v3.5.0...v3.5.1) (2026-08-17)


### Bug Fixes

* **web:** the favicon comet flies level, like miragon.io's own ([#99](https://github.com/Miragon/bpm-iq/issues/99)) ([b03cd39](https://github.com/Miragon/bpm-iq/commit/b03cd39680ba8d0d81627edd4795f9c8782b208c))

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
