import { Rocket } from "lucide-react";
export const ServerSideSwitch = ({ productionPort, hasServer, handleServerToggleChange, className = '', style = {} }) => {
    return (
        <div className="mb-6">
            <div className={`flex items-center justify-between p-5 bg-gradient-to-r from-indigo-50 to-blue-50 rounded-xl border border-indigo-100 ${className}`} style={style}>
                <div className="flex items-center gap-4">
                    <div className="p-3 bg-white rounded-lg shadow-sm">
                        <Rocket className="w-6 h-6 text-indigo-600" />
                    </div>
                    <div>
                        <p className="font-semibold text-black mb-1">Server-Side Application</p>
                        <p className="text-sm text-black/60">
                            {hasServer ? `This project runs a server runtime on port ${productionPort}` : 'Static files will be served directly'}
                        </p>
                    </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                    <input
                        type="checkbox"
                        checked={hasServer}
                        onChange={(e) => handleServerToggleChange(e.target.checked)}
                        className="sr-only peer"
                    />
                    <div className="w-14 h-8 bg-gray-300 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-200 rounded-full peer peer-checked:after:translate-x-6 peer-checked:after:border-white after:content-[''] after:absolute after:top-1 after:left-1 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-indigo-600"></div>
                </label>
            </div>
        </div>
    );
}