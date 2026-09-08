import { cn } from "../ui/cn";
import { ArrowUpRight } from "../ui/icons";
import { StripeRule } from "../ui/stripe-rule";

/**
 * Every link here resolves to something real. A footer of `href="#"` placeholders is worse
 * than no footer: on a page that moves money, a dead "how this works" link is the moment a
 * user decides the rest of the screen might be decorative too.
 */
export function SiteFooter({ wrapperContractId }: { wrapperContractId: string | null }) {
  return (
    <footer className="mx-auto w-full max-w-xl px-1 pb-14 pt-20">
      <StripeRule />
      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <p className="max-w-[26rem] text-xs leading-relaxed text-bone/40">
          Xebra moves native USDC over Circle&apos;s Cross-Chain Transfer Protocol. It never issues
          a wrapped asset and never takes custody of your funds.
        </p>
        <ul className="flex items-center gap-5">
          <FooterLink href="https://developers.circle.com/stablecoins/cctp-getting-started">
            CCTP
          </FooterLink>
          {wrapperContractId && (
            <FooterLink
              href={`https://stellar.expert/explorer/public/contract/${wrapperContractId}`}
            >
              Contract
            </FooterLink>
          )}
          <FooterLink href="https://github.com/drydocs/xebra">Source</FooterLink>
        </ul>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: string }) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={cn(
          "group/link flex items-center gap-1 text-xs font-medium text-bone/45",
          "transition-colors duration-400 ease-haptic hover:text-bone",
        )}
      >
        {children}
        <ArrowUpRight className="h-3 w-3 transition-transform duration-400 ease-haptic group-hover/link:-translate-y-px group-hover/link:translate-x-px" />
      </a>
    </li>
  );
}
