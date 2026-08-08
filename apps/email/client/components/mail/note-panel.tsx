import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuPortal,
} from '@/components/ui/dropdown-menu';
import {
  NOTE_COLORS,
  getNoteColorClass,
  getNoteColorStyle,
  formatRelativeTime,
  borderToBackgroundColorClass,
  assignOrdersAfterPinnedReorder,
  assignOrdersAfterUnpinnedReorder,
  sortNotesByOrder,
} from '@/lib/notes-utils';
import {
  StickyNote,
  Edit,
  Trash2,
  X,
  PlusCircle,
  Copy,
  Clock,
  Search,
  AlertCircle,
  Pin,
  PinOff,
  GripVertical,
  PaintBucket,
  MoreVertical,
} from 'lucide-react';
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useState, useRef, useEffect, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTRPC } from '@/providers/query-provider';
import { Textarea } from '@/components/ui/textarea';
import { useMutation } from '@tanstack/react-query';
import { useThreadNotes } from '@/hooks/use-notes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { m } from '@/paraglide/messages';
import { CSS } from '@dnd-kit/utilities';
import type { Note } from '@/types';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface NotesPanelProps {
  threadId: string;
}

function SortableNote({
  note,
  onEdit,
  onCopy,
  onTogglePin,
  onDelete,
  onColorChange,
}: {
  note: Note;
  onEdit: () => void;
  onCopy: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onColorChange: (color: string) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({
      id: note.id,
    });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative mb-3 overflow-hidden rounded-md border border-[#E7E7E7] p-3 dark:border-[#252525]',
        note.isPinned && 'ring-1 ring-amber-200 dark:ring-amber-800',
        note.color === 'default' ? 'bg-white dark:bg-[#202020]' : '',
      )}
    >
      <div
        className={cn(
          'absolute bottom-0 left-0 top-0 w-1.5 border-l-4',
          note.color !== 'default' ? getNoteColorClass(note.color) : 'border-transparent',
        )}
        style={note.color !== 'default' ? getNoteColorStyle(note.color) : {}}
      />

      <div className="flex items-start gap-3 pl-1.5">
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-sm text-black dark:text-white/90">
            {note.content}
          </p>

          <div className="mt-2 flex cursor-default items-center text-xs text-muted-foreground dark:text-[#8C8C8C]">
            <Clock className="mr-1 h-3 w-3" />
            <span>{formatRelativeTime(note.createdAt)}</span>
          </div>
        </div>

        <div className="flex items-center">
          <div
            ref={setActivatorNodeRef}
            {...listeners}
            {...attributes}
            className="cursor-grab opacity-30 group-hover:opacity-100"
          >
            <GripVertical className="text-muted-foreground h-4 w-4" />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 p-0 opacity-30 group-hover:opacity-100">
                <MoreVertical className="h-4 w-4" />
                <span className="sr-only">More</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="dark:bg-panelDark border-[#E7E7E7] bg-[#FAFAFA] dark:border-[#252525]"
            >
              <DropdownMenuItem
                onClick={onEdit}
                className="text-black focus:bg-white focus:text-black dark:text-white/90 dark:focus:bg-[#202020] dark:focus:text-white"
              >
                <Edit className="mr-2 h-4 w-4" />
                <span>{m['common.notes.actions.edit']()}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onCopy}
                className="text-black focus:bg-white focus:text-black dark:text-white/90 dark:focus:bg-[#202020] dark:focus:text-white"
              >
                <Copy className="mr-2 h-4 w-4" />
                <span>{m['common.notes.actions.copy']()}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onTogglePin}
                className="text-black focus:bg-white focus:text-black dark:text-white/90 dark:focus:bg-[#202020] dark:focus:text-white"
              >
                {note.isPinned ? (
                  <>
                    <PinOff className="mr-2 h-4 w-4" />
                    <span>{m['common.notes.actions.unpin']()}</span>
                  </>
                ) : (
                  <>
                    <Pin className="mr-2 h-4 w-4" />
                    <span>{m['common.notes.actions.pin']()}</span>
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="text-black focus:bg-white focus:text-black dark:text-white/90 dark:focus:bg-[#202020] dark:focus:text-white">
                  <PaintBucket className="mr-2 h-4 w-4" />
                  <span>{m['common.notes.actions.changeColor']()}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="dark:bg-panelDark w-48 border-[#E7E7E7] bg-[#FAFAFA] dark:border-[#252525]">
                    <DropdownMenuRadioGroup value={note.color} onValueChange={onColorChange}>
                      {NOTE_COLORS.map((color) => {
                        return (
                          <DropdownMenuRadioItem
                            key={color.value}
                            value={color.value}
                            className="text-black focus:bg-white focus:text-black dark:text-white/90 dark:focus:bg-[#202020] dark:focus:text-white"
                          >
                            <div className="flex items-center">
                              <div
                                className={cn(
                                  'mr-2 h-3 w-3 rounded-full',
                                  color.value !== 'default'
                                    ? borderToBackgroundColorClass(color.class)
                                    : 'border-border border bg-transparent',
                                )}
                              />
                              <span>{color.label}</span>
                            </div>
                          </DropdownMenuRadioItem>
                        );
                      })}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
              <DropdownMenuSeparator className="bg-[#E7E7E7] dark:bg-[#252525]" />
              <DropdownMenuItem
                onClick={onDelete}
                className="text-red-600 focus:bg-white focus:text-red-600 dark:text-red-400 dark:focus:bg-[#202020] dark:focus:text-red-400"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                <span>{m['common.notes.actions.delete']()}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

export function NotesPanel({ threadId }: NotesPanelProps) {
  const {
    data: { notes },
    refetch,
  } = useThreadNotes(threadId);
  const [isOpen, setIsOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [editContent, setEditContent] = useState('');
  const [isAddingNewNote, setIsAddingNewNote] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedColor, setSelectedColor] = useState('default');
  const [activeId, setActiveId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const trpc = useTRPC();
  const { mutateAsync: createNote } = useMutation(trpc.notes.create.mutationOptions());
  const { mutateAsync: updateNote } = useMutation(trpc.notes.update.mutationOptions());
  const { mutateAsync: deleteNote } = useMutation(trpc.notes.delete.mutationOptions());
  const { mutateAsync: reorderNotes } = useMutation(trpc.notes.reorder.mutationOptions());

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handlePanelClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  useEffect(() => {
    if (isAddingNewNote && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isAddingNewNote]);

  useEffect(() => {
    if (editingNoteId && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editingNoteId]);

  const handleAddNote = async () => {
    if (newNoteContent.trim()) {
      const noteData = {
        threadId,
        color: selectedColor !== 'default' ? selectedColor : undefined,
        content: newNoteContent.trim(),
      };

      const promise = async () => {
        setIsAddingNewNote(true);
        await createNote(noteData);
        await refetch();
        setNewNoteContent('');
        setSelectedColor('default');
        setIsAddingNewNote(false);
      };

      toast.promise(promise(), {
        loading: m['common.actions.loading'](),
        success: m['common.notes.noteAdded'](),
        error: m['common.notes.errors.failedToAddNote'](),
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, action: 'add' | 'edit') => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (action === 'add') {
        void handleAddNote();
      } else {
        void handleEditNote();
      }
    }
  };

  const handleEditNote = async () => {
    if (editingNoteId && editContent.trim()) {
      const noteId = editingNoteId;
      const contentToSave = editContent.trim();

      setEditingNoteId(null);
      setEditContent('');

      const promise = async () => {
        await updateNote({
          noteId,
          data: {
            content: contentToSave,
          },
        });
        await refetch();
      };

      toast.promise(promise(), {
        loading: m['common.actions.saving'](),
        success: m['common.notes.noteUpdated'](),
        error: m['common.notes.errors.failedToUpdateNote'](),
      });
    }
  };

  const startEditing = (note: Note) => {
    setEditingNoteId(note.id);
    setEditContent(note.content);
  };

  const handleDeleteNote = async (noteId: string) => {
    try {
      await deleteNote({ noteId });
      await refetch();
    } catch (error) {
      console.error('Failed to delete note:', error);
      throw error;
    }
  };

  const confirmDeleteNote = (noteId: string) => {
    // TODO: Dialog is bugged? needs to be fixed then implement a confirmation dialog
    const promise = handleDeleteNote(noteId);
    toast.promise(promise, {
      loading: m['common.actions.loading'](),
      success: m['common.notes.noteDeleted'](),
      error: m['common.notes.errors.failedToDeleteNote'](),
    });
  };

  const handleCopyNote = (content: string) => {
    navigator.clipboard.writeText(content);
    toast.success(m['common.notes.noteCopied']());
  };

  const togglePinNote = async (noteId: string, isPinned: boolean) => {
    const action = updateNote({
      noteId,
      data: { isPinned: !isPinned },
    });

    toast.promise(action, {
      loading: m['common.actions.loading'](),
      success: isPinned ? m['common.notes.noteUnpinned']() : m['common.notes.notePinned'](),
      error: m['common.notes.errors.failedToUpdateNote'](),
    });

    await action;
    return await refetch();
  };

  const handleChangeNoteColor = async (noteId: string, color: string) => {
    const action = updateNote({
      noteId,
      data: {
        color,
      },
    });

    toast.promise(action, {
      loading: m['common.actions.loading'](),
      success: m['common.notes.colorChanged'](),
      error: m['common.notes.errors.failedToUpdateNoteColor'](),
    });

    await action;
    return await refetch();
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const activeNote = notes.find((n) => n.id === active.id);
      const overNote = notes.find((n) => n.id === over.id);

      if (!activeNote || !overNote || activeNote.isPinned !== overNote.isPinned) {
        setActiveId(null);
        return;
      }

      const pinnedNotes = notes.filter((note) => note.isPinned);
      const unpinnedNotes = notes.filter((note) => !note.isPinned);

      if (activeNote.isPinned) {
        const oldIndex = pinnedNotes.findIndex((n) => n.id === active.id);
        const newIndex = pinnedNotes.findIndex((n) => n.id === over.id);
        const newPinnedNotes = arrayMove(pinnedNotes, oldIndex, newIndex);

        const reorderedPinnedNotes = assignOrdersAfterPinnedReorder(newPinnedNotes);

        const newNotes = [...reorderedPinnedNotes, ...unpinnedNotes];
        const action = reorderNotes({ notes: newNotes });

        toast.promise(action, {
          loading: m['common.actions.loading'](),
          success: m['common.notes.notesReordered'](),
          error: m['common.notes.errors.failedToReorderNotes'](),
        });

        await action;
        await refetch();
      } else {
        const oldIndex = unpinnedNotes.findIndex((n) => n.id === active.id);
        const newIndex = unpinnedNotes.findIndex((n) => n.id === over.id);
        const newUnpinnedNotes = arrayMove(unpinnedNotes, oldIndex, newIndex);

        const reorderedUnpinnedNotes = assignOrdersAfterUnpinnedReorder(
          newUnpinnedNotes,
          pinnedNotes.length,
        );

        const newNotes = [...pinnedNotes, ...reorderedUnpinnedNotes];
        const action = reorderNotes({ notes: newNotes });

        toast.promise(action, {
          loading: m['common.actions.loading'](),
          success: m['common.notes.notesReordered'](),
          error: m['common.notes.errors.failedToReorderNotes'](),
        });

        await action;
        await refetch();
      }
    }

    setActiveId(null);
  };

  const filteredNotes = useMemo(
    () => notes.filter((note) => note.content.toLowerCase().includes(searchQuery.toLowerCase())),
    [notes, searchQuery],
  );

  const pinnedNotes = useMemo(() => filteredNotes.filter((note) => note.isPinned), [filteredNotes]);

  const unpinnedNotes = useMemo(
    () => filteredNotes.filter((note) => !note.isPinned),
    [filteredNotes],
  );

  const sortedPinnedNotes = useMemo(() => sortNotesByOrder(pinnedNotes), [pinnedNotes]);

  const sortedUnpinnedNotes = useMemo(() => sortNotesByOrder(unpinnedNotes), [unpinnedNotes]);

  const pinnedIds = useMemo(() => sortedPinnedNotes.map((note) => note.id), [sortedPinnedNotes]);

  const unpinnedIds = useMemo(
    () => sortedUnpinnedNotes.map((note) => note.id),
    [sortedUnpinnedNotes],
  );

  return (
    <div className="relative" ref={panelRef}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center gap-1 overflow-hidden rounded-lg bg-white dark:bg-[#313131]',
              notes.length > 0 && 'text-amber-500',
              isOpen && 'bg-white/80 dark:bg-[#313131]/80',
            )}
            onClick={() => setIsOpen(!isOpen)}
          >
            <StickyNote
              className={cn(
                'h-4 w-4',
                notes.length > 0 ? 'fill-amber-200 dark:fill-amber-900' : 'text-[#9A9A9A]',
              )}
            />
            {notes.length > 0 && (
              <span className="bg-primary text-primary-foreground absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px]">
                {notes.length}
              </span>
            )}
            <span className="sr-only">{m['common.notes.title']()}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-white dark:bg-[#313131]">
          <p>{m['common.notes.noteCount']({ count: notes.length })}</p>
        </TooltipContent>
      </Tooltip>

      {isOpen && (
        <div
          className="animate-in fade-in-20 zoom-in-95 dark:bg-panelDark max-w-screen fixed top-20 z-50 h-[calc(100dvh-5rem)] max-h-[calc(100dvh-5rem)] w-full overflow-hidden rounded-t-lg border border-t bg-[#FAFAFA] shadow-lg duration-100 sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:h-auto sm:max-h-[80vh] sm:w-[350px] sm:max-w-[90vw] sm:rounded-xl sm:border lg:left-[-200px] xl:left-[-300px] dark:border-[#252525]"
          onClick={handlePanelClick}
        >
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#E7E7E7] p-3 dark:border-[#252525]">
            <h3 className="flex items-center text-sm font-medium text-black dark:text-white">
              <StickyNote className="mr-2 h-4 w-4" />
              {m['common.notes.title']()}{' '}
              {notes.length > 0 && (
                <Badge variant="outline" className="ml-2">
                  {notes.length}
                </Badge>
              )}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-md p-0 hover:bg-white/10"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-4 w-4 fill-[#9A9A9A]" />
              <span className="sr-only">{m['common.actions.close']()}</span>
            </Button>
          </div>

          {notes.length > 0 && (
            <div className="sticky top-[49px] z-10 px-3 pb-0 pt-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-[#9A9A9A]" />
                <Input
                  placeholder={m['common.notes.search']()}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="border-[#E7E7E7] bg-white pl-8 text-sm text-black placeholder:text-[#797979] focus:outline-none dark:border-[#252525] dark:bg-[#202020] dark:text-white"
                />
              </div>
            </div>
          )}

          <div className="flex h-full flex-col sm:max-h-[calc(80vh-100px)]">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <ScrollArea className="flex-1 overflow-y-auto">
                <div className="p-3">
                  {notes.length === 0 && !isAddingNewNote ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                      <StickyNote className="mb-2 h-12 w-12 text-[#8C8C8C] opacity-50" />
                      <p className="text-sm text-black dark:text-white/90">
                        {m['common.notes.empty']()}
                      </p>
                      <p className="mb-4 mt-1 max-w-[80%] text-xs text-muted-foreground dark:text-[#8C8C8C]">
                        {m['common.notes.emptyDescription']()}
                      </p>
                      <Button
                        variant="default"
                        size="xs"
                        className="mt-1"
                        onClick={() => setIsAddingNewNote(true)}
                      >
                        <PlusCircle className="mr-1 h-4 w-4" />
                        {m['common.notes.addNote']()}
                      </Button>
                    </div>
                  ) : (
                    <>
                      {searchQuery && filteredNotes.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-6 text-center">
                          <AlertCircle className="mb-2 h-10 w-10 text-[#8C8C8C] opacity-50" />
                          <p className="text-sm text-black dark:text-white/90">
                            {m['common.notes.noMatchingNotes']({ query: searchQuery })}
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-4 border-[#E7E7E7] bg-white text-black dark:border-[#252525] dark:bg-[#313131] dark:text-white/90"
                            onClick={() => setSearchQuery('')}
                          >
                            {m['common.notes.clearSearch']()}
                          </Button>
                        </div>
                      ) : (
                        <>
                          {sortedPinnedNotes.length > 0 && (
                            <div className="mb-3">
                              <div className="mb-2 flex items-center">
                                <Pin className="mr-1 h-3 w-3 text-amber-500" />
                                <span className="text-muted-foreground text-xs font-medium">
                                  {m['common.notes.pinnedNotes']()}
                                </span>
                              </div>

                              <SortableContext
                                items={pinnedIds}
                                strategy={verticalListSortingStrategy}
                              >
                                {sortedPinnedNotes.map((note) => (
                                  <SortableNote
                                    key={note.id}
                                    note={note}
                                    onEdit={() => startEditing(note)}
                                    onCopy={() => handleCopyNote(note.content)}
                                    onTogglePin={() => togglePinNote(note.id, !!note.isPinned)}
                                    onDelete={() => confirmDeleteNote(note.id)}
                                    onColorChange={(color) => handleChangeNoteColor(note.id, color)}
                                  />
                                ))}
                              </SortableContext>
                            </div>
                          )}

                          {sortedUnpinnedNotes.length > 0 && (
                            <div>
                              {sortedPinnedNotes.length > 0 && sortedUnpinnedNotes.length > 0 && (
                                <div className="mb-2 flex items-center">
                                  <span className="text-muted-foreground text-xs font-medium">
                                    {m['common.notes.otherNotes']()}
                                  </span>
                                </div>
                              )}

                              <SortableContext
                                items={unpinnedIds}
                                strategy={verticalListSortingStrategy}
                              >
                                {sortedUnpinnedNotes.map((note) => (
                                  <SortableNote
                                    key={note.id}
                                    note={note}
                                    onEdit={() => startEditing(note)}
                                    onCopy={() => handleCopyNote(note.content)}
                                    onTogglePin={() => togglePinNote(note.id, !!note.isPinned)}
                                    onDelete={() => confirmDeleteNote(note.id)}
                                    onColorChange={(color) => handleChangeNoteColor(note.id, color)}
                                  />
                                ))}
                              </SortableContext>
                            </div>
                          )}
                        </>
                      )}

                      {isAddingNewNote && (
                        <div className="relative mb-3 overflow-hidden rounded-md border-[#E7E7E7] bg-[#FFFFFF] dark:border-[#252525] dark:bg-[#202020]">
                          <div
                            className={cn(
                              'absolute bottom-0 left-0 top-0 w-1.5 border-l-4',
                              selectedColor !== 'default'
                                ? getNoteColorClass(selectedColor)
                                : 'border-transparent',
                            )}
                            style={
                              selectedColor !== 'default' ? getNoteColorStyle(selectedColor) : {}
                            }
                          />

                          <div className="">
                            <Textarea
                              ref={textareaRef}
                              value={newNoteContent}
                              onChange={(e) => setNewNoteContent(e.target.value)}
                              onKeyDown={(e) => handleKeyDown(e, 'add')}
                              className="min-h-[20px] resize-none border-none bg-transparent text-black focus:outline-none dark:text-white/90"
                              placeholder={m['common.notes.addYourNote']()}
                            />

                            <div className="mt-2 flex flex-wrap items-center justify-between gap-y-2 px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground dark:text-[#8C8C8C]">
                                  {m['common.notes.label']()}
                                </span>
                                <div className="flex flex-wrap gap-1.5">
                                  {NOTE_COLORS.map((color) => (
                                    <Tooltip key={color.value}>
                                      <TooltipTrigger asChild>
                                        <button
                                          onClick={() => setSelectedColor(color.value)}
                                          className={cn(
                                            'h-5 w-5 rounded-full',
                                            color.value === 'default' ? 'bg-background border' : '',
                                            color.value === 'red' ? 'bg-red-500' : '',
                                            color.value === 'orange' ? 'bg-orange-500' : '',
                                            color.value === 'yellow' ? 'bg-amber-500' : '',
                                            color.value === 'green' ? 'bg-green-500' : '',
                                            color.value === 'blue' ? 'bg-blue-500' : '',
                                            color.value === 'purple' ? 'bg-purple-500' : '',
                                            color.value === 'pink' ? 'bg-pink-500' : '',
                                            selectedColor === color.value &&
                                              'ring-primary ring-2 ring-offset-1',
                                          )}
                                          aria-label={color.label}
                                        />
                                      </TooltipTrigger>
                                      <TooltipContent
                                        side="bottom"
                                        className="bg-white dark:bg-[#313131]"
                                      >
                                        {color.label}
                                      </TooltipContent>
                                    </Tooltip>
                                  ))}
                                </div>
                              </div>
                            </div>

                            <div className="mx-1 my-2 flex justify-between">
                              <Button
                                variant="ghost"
                                size="xs"
                                className="text-muted-foreground dark:text-[#8C8C8C] hover:bg-white/10 hover:text-[#a0a0a0]"
                                onClick={() => {
                                  setIsAddingNewNote(false);
                                  setNewNoteContent('');
                                }}
                              >
                                {m['common.notes.cancel']()}
                              </Button>
                              <Button
                                variant="default"
                                size="xs"
                                onClick={() => void handleAddNote()}
                                disabled={!newNoteContent.trim()}
                              >
                                {m['common.notes.save']()}
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}

                      {!isAddingNewNote && (
                        <Button
                          variant="outline"
                          size="xs"
                          className="mt-1 w-full border-[#E7E7E7] bg-white/5 hover:bg-white/10 dark:border-[#252525] dark:text-white/90"
                          onClick={() => setIsAddingNewNote(true)}
                        >
                          <PlusCircle className="mr-2 h-4 w-4" />
                          {m['common.notes.addNote']()}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </ScrollArea>

              <DragOverlay>
                {activeId ? (
                  <div className="rounded-md border border-[#E7E7E7] bg-white p-3 pl-7 shadow-md dark:border-[#252525] dark:bg-[#202020]">
                    <div className="pl-1.5">
                      <div className="whitespace-pre-wrap break-words text-sm text-black dark:text-white/90">
                        {notes.find((n) => n.id === activeId)?.content}
                      </div>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>

            {editingNoteId && (
              <div className="dark:bg-panelDark border-t border-[#E7E7E7] bg-[#FAFAFA] p-3 dark:border-[#252525]">
                <div className="space-y-2">
                  <div className="mb-1 text-xs font-medium text-muted-foreground dark:text-[#8C8C8C]">
                    {m['common.notes.editNote']()}:
                  </div>
                  <Textarea
                    ref={textareaRef}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, 'edit')}
                    className="min-h-[100px] resize-none border-[#E7E7E7] bg-[#FFFFFF] text-sm text-black dark:border-[#252525] dark:bg-[#202020] dark:text-white/90"
                    placeholder={m['common.notes.addYourNote']()}
                  />

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground dark:text-[#8C8C8C] hover:bg-white/10 hover:text-[#a0a0a0]"
                      onClick={() => {
                        setEditingNoteId(null);
                        setEditContent('');
                      }}
                    >
                      {m['common.notes.cancel']()}
                    </Button>
                    <Button variant="default" size="xs" onClick={() => void handleEditNote()}>
                      {m['common.actions.saveChanges']()}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
