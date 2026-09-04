/** the event storming board widget — the Miragon engine on the shared widget core; no
 *  extras, no icon font, the file-route deep link (core/widget.ts defaults) */
import "./event-storming-styles.css";

import { bootWidget } from "./core/widget";
import { mountEventStormingEngine } from "./engines/event-storming";

bootWidget({ notation: "event-storming", noun: "event storming board", engine: mountEventStormingEngine });
