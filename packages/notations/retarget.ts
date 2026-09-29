/**
 * Retarget cross-model references — the write-side twin of the refs
 * capability (./refs). Renaming a model changes its id (= file stem), and
 * every reference resolves by that stem (#208), so the models pointing at it
 * are rewritten to the new id instead of being left dangling.
 *
 * A TARGETED text rewrite, never a parse → serialize round trip: only the
 * attribute values that name the old id change, every other byte of the file
 * (formatting, comments, vendor extensions) stays exactly as it was — the
 * release diff of a caller is the one attribute. The spellings are exactly the
 * ones the refs emitter follows (extract.ts decisionRefOf), so a link the
 * platform reads is a link this rewrites:
 *
 *   callActivity      calledElement="x"                          → a process
 *   businessRuleTask  decisionRef / calledDecision / calledElement="x"
 *                     <calledDecision decisionId="x"/>            → a decision
 *
 * Pure + browser-safe: string in, string out. Notations without refs return
 * their content untouched.
 */
import { escapeXml } from "./templates.ts";

/** the model a set of references is moved from one id to another */
export interface RetargetSpec {
  /** notation of the renamed model ("bpmn" for calls, "dmn" for decides) */
  notation: string;
  /** its old id (file stem) */
  from: string;
  /** its new id (file stem) */
  to: string;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** start tags of the elements that carry references, any namespace prefix */
const REF_TAGS = /<(?:[\w.-]+:)?(callActivity|businessRuleTask|calledDecision)\b[^>]*>/g;

/** the attributes of a start tag that name the target, per tag */
function attributesFor(tag: string, notation: string): string[] {
  if (notation === "bpmn" && tag === "callActivity") return ["calledElement"];
  if (notation === "dmn" && tag === "businessRuleTask") return ["decisionRef", "calledDecision", "calledElement"];
  if (notation === "dmn" && tag === "calledDecision") return ["decisionId"];
  return [];
}

/**
 * `content` with every reference to `spec.from` (of `spec.notation`) pointing
 * at `spec.to` instead. `notation` is the notation of the CONTENT — only BPMN
 * emits references today; anything else comes back unchanged.
 */
export function retargetRefs(notation: string, content: string, spec: RetargetSpec): string {
  if (notation !== "bpmn" || spec.from === spec.to) return content;
  const from = escapeRegExp(escapeXml(spec.from));
  const to = escapeXml(spec.to);
  return content.replace(REF_TAGS, (startTag, tag: string) => {
    let out = startTag;
    for (const attr of attributesFor(tag, spec.notation)) {
      // the value may carry surrounding blanks (decisionRefOf trims them) —
      // the rewritten value is the clean id
      const value = new RegExp(`(\\s(?:[\\w.-]+:)?${attr}\\s*=\\s*)(["'])\\s*${from}\\s*\\2`, "g");
      out = out.replace(value, (_m, lead: string, quote: string) => `${lead}${quote}${to}${quote}`);
    }
    return out;
  });
}
