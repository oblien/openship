import React, { useRef, useState, KeyboardEvent, ClipboardEvent } from 'react';

interface OTPInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

const OTPInput: React.FC<OTPInputProps> = ({
  length = 6,
  value,
  onChange,
  disabled = false,
  autoFocus = false,
}) => {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(autoFocus ? 0 : null);

  // Initialize refs array
  if (inputRefs.current.length !== length) {
    inputRefs.current = Array(length).fill(null);
  }

  // Split value into array of digits
  const digits = value.split('').concat(Array(length).fill('')).slice(0, length);

  const focusInput = (index: number) => {
    if (index >= 0 && index < length) {
      inputRefs.current[index]?.focus();
      setFocusedIndex(index);
    }
  };

  const handleChange = (index: number, digit: string) => {
    // Only allow single digit
    const newDigit = digit.replace(/\D/g, '').slice(-1);
    
    const newDigits = [...digits];
    newDigits[index] = newDigit;
    const newValue = newDigits.join('').replace(/\s/g, '');
    
    onChange(newValue);

    // Auto-focus next input if digit was entered
    if (newDigit && index < length - 1) {
      focusInput(index + 1);
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!digits[index] && index > 0) {
        // If current input is empty, focus previous and delete its value
        const newDigits = [...digits];
        newDigits[index - 1] = '';
        onChange(newDigits.join('').replace(/\s/g, ''));
        focusInput(index - 1);
      } else if (digits[index]) {
        // Delete current digit
        const newDigits = [...digits];
        newDigits[index] = '';
        onChange(newDigits.join('').replace(/\s/g, ''));
      }
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' && index > 0) {
      focusInput(index - 1);
    } else if (e.key === 'ArrowRight' && index < length - 1) {
      focusInput(index + 1);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text/plain').replace(/\D/g, '').slice(0, length);
    onChange(pastedData);
    
    // Focus the next empty input or last input
    const nextIndex = Math.min(pastedData.length, length - 1);
    focusInput(nextIndex);
  };

  return (
    <div className="flex gap-2 justify-center">
      {Array.from({ length }).map((_, index) => (
        <input
          key={index}
          ref={(el) => {
            if (el) {
              inputRefs.current[index] = el;
            }
          }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={digits[index] || ''}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={handlePaste}
          onFocus={() => setFocusedIndex(index)}
          onBlur={() => setFocusedIndex(null)}
          disabled={disabled}
          autoFocus={autoFocus && index === 0}
          className={`w-12 h-14 text-center text-2xl font-mono font-semibold bg-white border-2 rounded-xl transition-all
            ${focusedIndex === index 
              ? 'border-indigo-500 ring-2 ring-indigo-500/20 scale-105' 
              : digits[index] 
                ? 'border-indigo-300' 
                : 'border-black/10'
            }
            ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-black/20'}
            focus:outline-none
          `}
        />
      ))}
    </div>
  );
};

export default OTPInput;

