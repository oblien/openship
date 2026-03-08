export function StacksVisual() {
  const stacks = [
    { name: "Go",         slug: "go" },
    { name: "Rust",       slug: "rust" },
    { name: "Python",     slug: "python" },
    { name: "Node.js",    slug: "nodedotjs" },
    { name: "Ruby",       slug: "ruby" },
    { name: "PHP",        slug: "php" },
    { name: "Java",       slug: "openjdk" },
    { name: ".NET",       slug: "dotnet" },
    { name: "Elixir",     slug: "elixir" },
    { name: "Docker",     slug: "docker" },
    { name: "Bun",        slug: "bun" },
    { name: "Deno",       slug: "deno" },
    { name: "Rails",      slug: "rubyonrails" },
    { name: "Django",     slug: "django" },
    { name: "Laravel",    slug: "laravel" },
    { name: "PostgreSQL", slug: "postgresql" },
    { name: "Redis",      slug: "redis" },
    { name: "Nginx",      slug: "nginx" },
  ];

  return (
    <div className="w-full">
      <div className="grid grid-cols-6 gap-[1px] rounded-xl overflow-hidden">
        {stacks.map((s) => (
          <div
            key={s.name}
            className="feat-build-item relative flex flex-col items-center justify-center gap-2.5 py-5 px-1.5"
            style={{ background: "rgba(255,255,255,0.05)" }}
          >
            {/* Icon — currentColor (inherits theme text color) */}
            <span
              className="h-6 w-6 block"
              style={{
                background: "currentColor",
                opacity: 0.55,
                maskImage: `url(https://cdn.simpleicons.org/${s.slug}/ffffff)`,
                WebkitMaskImage: `url(https://cdn.simpleicons.org/${s.slug}/ffffff)`,
                maskSize: "contain",
                WebkitMaskSize: "contain",
                maskRepeat: "no-repeat",
                WebkitMaskRepeat: "no-repeat",
                maskPosition: "center",
                WebkitMaskPosition: "center",
              }}
            />
            <span className="text-[11px] font-semibold leading-none text-center" style={{ color: "currentColor", opacity: 0.40 }}>{s.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
