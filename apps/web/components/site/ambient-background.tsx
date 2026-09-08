/**
 * The room the plate sits in.
 *
 * Three layers, all fixed and non-interactive so none of them ever joins a scroll repaint:
 * a wide bone-tinted key light above the card, a colder fill from the lower left, and the
 * hide stripes at the density of a rumour. The gradients are radial and off-centre on
 * purpose — an even 45° linear fade is the single most recognisable "generated" background.
 *
 * There is no colour here. A monochrome product that reaches for a purple glow to look
 * finished has stopped believing its own palette.
 */
export function AmbientBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Key light: a soft bone wash behind the headline and the top of the plate. */}
      <div
        className="absolute left-1/2 top-[-28rem] h-[52rem] w-[70rem] -translate-x-1/2 rounded-full opacity-[0.14] blur-[120px]"
        style={{
          background:
            "radial-gradient(ellipse at center, hsl(var(--bone) / 0.55), transparent 62%)",
        }}
      />
      {/* Bounce: sits directly behind the plate. Without it the card's `backdrop-blur` has
          nothing but flat obsidian to sample and the glass reads as a grey rectangle. */}
      <div
        className="absolute left-1/2 top-[38%] h-[34rem] w-[52rem] -translate-x-1/2 rounded-full opacity-[0.10] blur-[110px]"
        style={{
          background: "radial-gradient(ellipse at center, hsl(var(--bone) / 0.4), transparent 65%)",
        }}
      />
      {/* Fill: cooler, lower, and offset so the lighting has a direction. */}
      <div
        className="absolute -left-40 bottom-[-22rem] h-[40rem] w-[46rem] rounded-full opacity-[0.16] blur-[130px]"
        style={{
          background: "radial-gradient(ellipse at center, hsl(215 40% 30%), transparent 68%)",
        }}
      />
      {/* The hide, at the scale of the whole page rather than a card. */}
      <div className="hide-stripes absolute inset-0 opacity-[0.55] [mask-image:radial-gradient(ellipse_70%_50%_at_50%_0%,black,transparent)]" />
      {/* Vignette, so the page edges fall away instead of stopping. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 100% 70% at 50% 20%, transparent, hsl(var(--obsidian) / 0.85))",
        }}
      />
    </div>
  );
}
