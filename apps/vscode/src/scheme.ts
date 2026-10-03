/**
 * The URI scheme of live model documents: designiq:/<owner>/<repo>/<path> —
 * the path IS the room name. Its own module, free of the vscode API, so the
 * file system (extension.ts) and the unit-tested picker (model-picker.ts)
 * share the one literal; package.json's onFileSystem activation event names
 * it too (pinned by src/test/unit/manifest.test.ts).
 */
export const SCHEME = "designiq";
