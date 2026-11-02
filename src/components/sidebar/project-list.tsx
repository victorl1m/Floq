import CanonicalProjectList from "./canonical-project-list";

/** Project sidebar backed by the runtime's canonical project/workspace registry. */
export default function ProjectList() {
  return <CanonicalProjectList />;
}
