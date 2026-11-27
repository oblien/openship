import type { ComponentPropsWithoutRef, ReactNode } from "react";
import "./topology-node.css";

type TopologyNodeCardProps = ComponentPropsWithoutRef<"article"> & {
  name: string;
  description: string;
  icon: ReactNode;
};

export function TopologyNodeCard({ name, description, icon, children, className = "", ...props }: TopologyNodeCardProps) {
  return (
    <article {...props} className={`topology-node ${className}`}>
      <div className="topology-node-header">
        <span className="topology-node-icon">{icon}</span>
        <div className="topology-node-label">
          <h3 title={name}>{name}</h3>
          <p title={description}>{description}</p>
        </div>
      </div>
      {children}
    </article>
  );
}
