interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = ({ children, className = "", ...props }: SelectProps) => (
  <select
    className={`w-full px-3 py-2 bg-background border border-border rounded-md text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent ${className}`}
    {...props}
  >
    {children}
  </select>
);
