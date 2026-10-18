import { buildProjectHash } from "../utils/projectRouting";
import { NewProjectForm } from "./NewProjectForm";
import { HyperframesLogo } from "./ui/HyperframesLogo";

/** Opening the first project reloads: nothing is open yet, and the mount path resolves the hash. */
function openFirstProject(id: string): void {
  window.location.hash = buildProjectHash(id);
  window.location.reload();
}

function FirstProject({ canCreateProjects }: { canCreateProjects: boolean }) {
  if (!canCreateProjects) {
    return (
      <div className="flex flex-col items-center gap-3 text-center px-6" role="status">
        <p className="text-xs text-neutral-500">
          This Studio has no project yet. Create one with{" "}
          <code className="text-neutral-400 font-mono">npx hyperframes init</code>
        </p>
      </div>
    );
  }
  return (
    <section
      aria-labelledby="first-project-title"
      className="w-full max-w-md rounded-xl border border-border-strong bg-surface px-6 py-5 shadow-2xl"
    >
      <div className="mb-4 flex flex-col gap-2">
        <HyperframesLogo />
        <h1 id="first-project-title" className="text-step-12 font-medium text-text-1">
          Create your first project
        </h1>
      </div>
      <NewProjectForm onOpenProject={openFirstProject} />
    </section>
  );
}

export function StudioSplash({
  waiting,
  server,
}: {
  waiting?: boolean;
  /** What the server said when it answered; absent while it has not. */
  server?: { serverHasNoProjects: boolean; canCreateProjects: boolean };
}) {
  return (
    <div className="h-full w-full bg-neutral-950 flex items-center justify-center">
      {waiting && server?.serverHasNoProjects ? (
        <FirstProject canCreateProjects={server.canCreateProjects} />
      ) : waiting ? (
        <div className="flex flex-col items-center gap-3 text-center px-6" role="status">
          <div className="w-4 h-4 rounded-full border-2 border-neutral-700 border-t-neutral-500 animate-spin motion-reduce:animate-none" />
          <p className="text-xs text-neutral-600">
            Waiting for preview server… run{" "}
            <code className="text-neutral-500 font-mono">npm run dev</code>
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center px-6" role="status">
          <div className="w-4 h-4 rounded-full bg-studio-accent animate-pulse motion-reduce:animate-none" />
          <p className="text-xs text-neutral-600">Connecting to project…</p>
        </div>
      )}
    </div>
  );
}
