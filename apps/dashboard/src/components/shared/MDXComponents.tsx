import defaultComponents from "fumadocs-ui/mdx";
import * as TabsComponents from "fumadocs-ui/components/tabs";
import Image from "next/image";

export const mdxComponents: Record<string, React.ComponentType<any>> = {
  ...defaultComponents,
  ...TabsComponents,
  Figure: ({ src, alt, caption }: { src: string; alt: string; caption?: string }) => (
    <figure className="my-8">
      <Image
        src={src}
        alt={alt}
        width={800}
        height={600}
        className="rounded-lg"
      />
      {caption && (
        <figcaption className="text-sm text-muted-foreground text-center mt-2">
          {caption}
        </figcaption>
      )}
    </figure>
  ),
};