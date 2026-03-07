"use client";
import React, { useState } from "react";
import { generateIcon } from "@/utils/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";

export const ProjectIdentity: React.FC = () => {
  const { projectData, updateProjectData } = useProjectSettings();
  const [isEditingName, setIsEditingName] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);

  const [tempData, setTempData] = useState({ 
    name: projectData.name || '',
    description: projectData.description || '',
    framework: projectData.framework || ''
  });

  const [loading, setLoading] = useState({
    name: false,
    description: false,
  });
  
  const { showToast } = useToast();

  const handleSaveName = async () => {
    setLoading({ ...loading, name: true });
    const response = await projectsApi.update(projectData.id, 'name', tempData.name);
    if (response.success) {
      updateProjectData({ name: tempData.name });
      setIsEditingName(false);
    } else {
      showToast(response.message, 'error', 'Failed to update project name');
    }
    setLoading({ ...loading, name: false });
  };

  const handleSaveDescription = async () => {
    const response = await projectsApi.update(projectData.id, 'description', tempData.description);
    if (response.success) {
      updateProjectData({ description: tempData.description });
      setIsEditingDescription(false);
    } else {
      showToast(response.message, 'error', 'Failed to update project description');
    }
    setLoading({ ...loading, description: false });
  };

  const handleCancelName = () => {
    setTempData((prev) => ({ ...prev, name: projectData.name || '' }));
    setIsEditingName(false);
    setLoading({ ...loading, name: false });
  };

  const handleCancelDescription = () => {
    setTempData((prev) => ({ ...prev, description: projectData.description || '' }));
    setIsEditingDescription(false);
    setLoading({ ...loading, description: false });
  };


  return (
    <div className="bg-white rounded-[20px] border border-black/5 p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        {generateIcon('layers-363-1658238246.png', 28, 'rgb(79, 70, 229)')}
        <h3 className="text-lg font-semibold text-black">Project Identity</h3>
      </div>
      
      <div className="flex flex-col lg:flex-row gap-5 lg:gap-6">
        {/* Project Name */}
        <div className="flex-1">
          <label className="text-sm font-medium text-black/70 mb-2 block">Project Name</label>
          
          {isEditingName ? (
            <div className="space-y-3">
              <input
                type="text"
                value={tempData.name}
                onChange={(e) => setTempData((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="my-awesome-project"
                className="w-full px-4 py-2.5 bg-black/5 border border-transparent rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/20 focus:bg-white outline-none text-sm transition-all"
                autoFocus
              />
              <div className="flex gap-2">
                <button 
                  onClick={handleSaveName} 
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full transition-all text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Save
                </button>
                <button 
                  onClick={handleCancelName} 
                  className="px-4 py-2 bg-black/5 hover:bg-black/10 text-black rounded-full transition-all text-sm font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="relative p-4 bg-black/5 rounded-xl group hover:bg-black/10 transition-all">
              <p className="text-sm font-medium text-black pr-8">{projectData.name || 'Unnamed Project'}</p>
              <button
                onClick={() => setIsEditingName(true)}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-black/40 hover:text-indigo-600 transition-colors"
              >
                {generateIcon("pen-411-1658238246.png", 18, "currentColor")}
              </button>
            </div>
          )}
        </div>

        {/* Description */}
        <div className="flex-1">
          <label className="text-sm font-medium text-black/70 mb-2 block">Description</label>
          
          {isEditingDescription ? (
            <div className="space-y-3">
              <textarea
                value={tempData.description}
                onChange={(e) => setTempData((prev) => ({ ...prev, description: e.target.value }))}
                rows={3}
                placeholder="A modern web application built with..."
                className="w-full px-4 py-2.5 bg-black/5 border border-transparent rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/20 focus:bg-white outline-none resize-none text-sm transition-all"
                autoFocus
              />
              <div className="flex gap-2">
                <button 
                  onClick={handleSaveDescription} 
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full transition-all text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Save
                </button>
                <button 
                  onClick={handleCancelDescription} 
                  className="px-4 py-2 bg-black/5 hover:bg-black/10 text-black rounded-full transition-all text-sm font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="relative p-4 bg-black/5 rounded-xl group hover:bg-black/10 transition-all">
              <p className="text-sm text-black/70 pr-8">
                {projectData.description || 'No description provided'}
              </p>
              <button
                onClick={() => setIsEditingDescription(true)}
                className="absolute right-3 top-3 p-1.5 text-black/40 hover:text-indigo-600 transition-colors"
              >
                {generateIcon("pen-411-1658238246.png", 18, "currentColor")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};