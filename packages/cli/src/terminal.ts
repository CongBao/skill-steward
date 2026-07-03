const unsafeTerminalCharacter = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

export function terminalSafeText(value: string): string {
  return value.replace(unsafeTerminalCharacter, (character) =>
    `\\u{${character.codePointAt(0)!.toString(16).padStart(4, "0")}}`
  );
}
