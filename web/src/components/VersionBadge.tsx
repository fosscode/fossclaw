import pkg from "../../package.json";

export function VersionBadge() {
  return (
    <div className="fixed bottom-2 right-2 z-50 pointer-events-none">
      <span className="text-[10px] text-cc-fg/30 font-mono select-none">
        v{pkg.version}
      </span>
    </div>
  );
}
