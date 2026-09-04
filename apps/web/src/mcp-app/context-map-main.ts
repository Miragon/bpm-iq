/** the context map widget — the Miragon engine on the shared widget core; no
 *  extras, no icon font, the file-route deep link (core/widget.ts defaults) */
import "./context-map-styles.css";

import { bootWidget } from "./core/widget";
import { mountContextMapEngine } from "./engines/context-map";

bootWidget({ notation: "context-map", noun: "context map", engine: mountContextMapEngine });
