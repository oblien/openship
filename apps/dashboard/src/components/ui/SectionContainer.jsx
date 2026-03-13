export const SectionContainer = ({ children, className = '' }) => {
    return (
        <div className={`max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5 ${className}`}>
            {children}
        </div>
    )
}