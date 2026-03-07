import generateIcon from '@/utils/icons';

interface PlatformFeatureCardProps {
  icon: string;
  title: string;
  description: string;
}

export default function PlatformFeatureCard({ icon, title, description }: PlatformFeatureCardProps) {
  return (
    <div className="relative overflow-hidden bg-white/5 backdrop-blur-[25px] rounded-[20px] p-6 border border-white/10 group hover:border-white/20 transition-all duration-300">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute bg-transparent rounded-full border-white/10 -right-10 -top-10 w-40 h-40 border-[20px] blur-2xl group-hover:border-white/20 transition-all duration-300"></div>
        <div className="absolute bg-transparent rounded-full border-white/5 -left-10 -bottom-10 w-32 h-32 border-[15px] blur-xl group-hover:border-white/10 transition-all duration-300"></div>
      </div>
      
      <div className="relative z-10">
        <div className="mb-4">
          {generateIcon(icon, 40, 'rgba(255,255,255,0.5)')}
        </div>
        <h3 className="text-xl font-bold text-white mb-3">{title}</h3>
        <p className="text-white/60 leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

