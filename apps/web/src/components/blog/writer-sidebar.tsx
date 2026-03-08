interface Author {
  name: string;
  role: string;
  bio: string;
  twitter?: string;
  github?: string;
}

const AUTHORS: Record<string, Author> = {
  "Openship Team": {
    name: "Openship Team",
    role: "Core Team",
    bio: "Building open-source deployment infrastructure for everyone.",
    github: "openshiporg",
  },
};

function getAuthor(name?: string): Author {
  if (!name) return AUTHORS["Openship Team"];
  return (
    AUTHORS[name] ?? {
      name,
      role: "Contributor",
      bio: "Contributing to Openship.",
    }
  );
}

interface WriterSidebarProps {
  authorName?: string;
}

export default function BlogWriterSidebar({ authorName }: WriterSidebarProps) {
  const author = getAuthor(authorName);

  return (
    <aside className="bp-writer">
      {/* Avatar initial */}
      <div className="bp-writer-avatar">{author.name[0].toUpperCase()}</div>

      {/* Name & role */}
      <div className="bp-writer-name">{author.name}</div>
      <div className="bp-writer-role">{author.role}</div>

      {/* Bio */}
      <p className="bp-writer-bio">{author.bio}</p>

      {/* Social links */}
      {(author.twitter || author.github) && (
        <div className="bp-writer-links">
          {author.twitter && (
            <a
              href={`https://x.com/${author.twitter}`}
              target="_blank"
              rel="noopener noreferrer"
              className="bp-writer-link"
              aria-label={`${author.name} on X`}
            >
              <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          )}
          {author.github && (
            <a
              href={`https://github.com/${author.github}`}
              target="_blank"
              rel="noopener noreferrer"
              className="bp-writer-link"
              aria-label={`${author.name} on GitHub`}
            >
              <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
            </a>
          )}
        </div>
      )}
    </aside>
  );
}
