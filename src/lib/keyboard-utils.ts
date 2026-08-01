/**
 * Utility for detecting IME (Input Method Editor) composition state.
 * Prevents premature form submission when users are typing in CJK languages.
 * MIT licensed implementation.
 */

/**
 * Checks if the current keydown event is part of an IME composition session.
 * 
 * Returns true when the user is composing text using a Chinese, Japanese,
 * or Korean input method. This prevents Enter keys used to commit candidate
 * characters from being misinterpreted as form submission commands.
 *
 * Relies on two complementary signals:
 * - W3C standard `isComposing` property (active during composition)
 * - Legacy keyCode 229 (emitted by Chromium on the commit press itself)
 *
 * Use this check in all Enter-as-submit handlers on text inputs.
 *
 * @param e - The keyboard event from a text input
 * @returns True if the event is part of IME composition
 */
export function isImeComposing(e: React.KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229
}
