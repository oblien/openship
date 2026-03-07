import { ProjectSettingsProvider } from "@/context/ProjectSettingsContext";
import ProjectsBottomNavigation from "../components/ProjectsBottomNavigation";

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
      <ProjectsBottomNavigation />
    </ProjectSettingsProvider>
  );
};

export default ProjectSettingsWrapper;
