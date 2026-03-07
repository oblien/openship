import React from 'react';

interface AlertBoxProps {
  type: 'info' | 'warning' | 'danger';
  title: string;
  message: string;
}

const AlertBox: React.FC<AlertBoxProps> = ({ type, title, message }) => {
  const styles = {
    info: {
      container: 'bg-indigo-50 border-indigo-200',
      title: 'text-indigo-900',
      message: 'text-indigo-800',
    },
    warning: {
      container: 'bg-amber-50 border-amber-200',
      title: 'text-amber-900',
      message: 'text-amber-800',
    },
    danger: {
      container: 'bg-red-50 border-red-200',
      title: 'text-red-900',
      message: 'text-red-800',
    },
  };

  const style = styles[type];

  return (
    <div className={`${style.container} border rounded-xl p-4`}>
      <p className={`text-sm ${style.title} font-medium mb-1`}>{title}</p>
      <p className={`text-xs ${style.message}`}>{message}</p>
    </div>
  );
};

export default AlertBox;

