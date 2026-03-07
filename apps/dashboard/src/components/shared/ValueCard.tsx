import generateIcon from '@/utils/icons';

interface ValueCardProps {
  icon: string;
  title: string;
  description: string;
}

export default function ValueCard({ icon, title, description }: ValueCardProps) {
  return (
    <div className="bg-white/5 backdrop-blur-[25px] rounded-[25px] p-8 border border-white/10">
      <div className="mb-4">
        {generateIcon(icon, 48, 'rgba(255,255,255,0.5)')}
      </div>
      <h3 className="text-2xl font-bold text-white mb-4">{title}</h3>
      <p className="text-white/70 leading-relaxed">{description}</p>
    </div>
  );
}

