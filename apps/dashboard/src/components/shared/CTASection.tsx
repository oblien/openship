interface CTASectionProps {
  title: string;
  description: string;
  primaryButtonText: string;
  primaryButtonHref: string;
  secondaryButtonText: string;
  secondaryButtonHref: string;
}

export default function CTASection({
  title,
  description,
  primaryButtonText,
  primaryButtonHref,
  secondaryButtonText,
  secondaryButtonHref,
}: CTASectionProps) {
  return (
    <div className="bg-white rounded-[25px] p-8 lg:p-12 text-center">
      <h2 className="text-3xl lg:text-4xl font-bold text-black mb-6">
        {title}
      </h2>
      <p className="text-lg text-black/70 mb-8 max-w-2xl mx-auto">
        {description}
      </p>
      <div className="flex flex-col sm:flex-row gap-4 justify-center">
        <a
          href={primaryButtonHref}
          className="relative overflow-hidden group px-8 py-4 bg-black text-white font-semibold rounded-full hover:bg-black/90 transition-all duration-300"
        >
          <span className="absolute inset-0 -translate-x-full group-hover:translate-x-0 transition-transform duration-200 ease-out bg-white/10 rounded-full"></span>
          <span className="relative z-10">{primaryButtonText}</span>
        </a>
        <a
          href={secondaryButtonHref}
          className="relative overflow-hidden group px-8 py-4 bg-black/5 text-black font-semibold rounded-full border-2 border-black/10 hover:border-black/20 transition-all duration-300"
        >
          <span className="absolute inset-0 -translate-x-full group-hover:translate-x-0 transition-transform duration-200 ease-out bg-black/10 rounded-full"></span>
          <span className="relative z-10">{secondaryButtonText}</span>
        </a>
      </div>
    </div>
  );
}

