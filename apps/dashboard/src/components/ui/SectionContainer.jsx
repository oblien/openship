export const SectionContainer = ({ children, className = '' }) => {
    return (
        <div className={`lg:max-w-[80vw] w-full lg:w-[80vw] mx-auto px-2 md:px-4 w-[75vw] py-8 lg:px-7 space-y-5 ${className}`}>
            {children}
        </div>
    )
}