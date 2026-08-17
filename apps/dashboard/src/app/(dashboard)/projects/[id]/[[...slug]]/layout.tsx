import { ProjectSettingsProvider } from "@/context/ProjectSettingsContext";

const ProjectSettingsWrapper = async ({
  params,
  children,
}: {
  params: Promise<{ id: string; slug?: string[] }>;
  children: React.ReactNode;
}) => {

  const { id, slug } = await params;

  return (
    <ProjectSettingsProvider slug={slug} id={id}>
      {children}
    </ProjectSettingsProvider>
  );
};

export default ProjectSettingsWrapper;
