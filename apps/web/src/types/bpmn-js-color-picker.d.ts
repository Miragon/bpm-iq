/** bpmn-js-color-picker ships no types — its default export is a didi module
 *  (context-pad brush + color-picker popup), passed via additionalModules */
declare module "bpmn-js-color-picker" {
  const colorPickerModule: Record<string, unknown>;
  export default colorPickerModule;
}
