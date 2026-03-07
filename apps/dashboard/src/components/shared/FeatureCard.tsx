import generateIcon from '@/utils/icons';

interface FeatureCardProps {
  icon: string;
  title: string;
  description: string;
}

export default function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="bg-white/5 backdrop-blur-[25px] rounded-[20px] p-6 border border-white/10">
      <div className="mb-4">
        {generateIcon(icon, 40, 'rgba(255,255,255,0.5)')}
      </div>
      <h3 className="text-xl font-bold text-white mb-3">{title}</h3>
      <p className="text-white/60 leading-relaxed">{description}</p>
    </div>
  );
}

