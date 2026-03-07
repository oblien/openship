interface PageHeroProps {
  title: string;
  description?: string;
}

export default function PageHero({ title, description }: PageHeroProps) {
  return (
    <div className="text-center mb-16 lg:mb-24">
      <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6">
        {title}
      </h1>

      {description && (
        <p className="text-lg lg:text-xl text-white/60 max-w-3xl mx-auto leading-relaxed">
          {description}
        </p>
      )}
    </div>
  );
}

