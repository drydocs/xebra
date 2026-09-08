/**
 * Class-name joiner. Deliberately not `clsx` + `tailwind-merge`: this app has one screen and
 * a fixed component set, so nothing here composes conflicting utilities at runtime — pulling
 * two dependencies in to solve a problem the code does not have would be the expensive kind
 * of convenience.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
