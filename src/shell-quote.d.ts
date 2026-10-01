declare module 'shell-quote' {
  export type ParsedToken = string | { op: string; flag?: string };
  export function parse(input: string): ParsedToken[];
  export function quote(tokens: readonly ParsedToken[]): string;
}
