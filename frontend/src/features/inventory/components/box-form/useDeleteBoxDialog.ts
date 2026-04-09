import { useCallback, useEffect, useRef, useState } from 'react';

const DELETE_DIALOG_FADE_MS = 180;
const DELETE_BACKDROP_FADE_MS = 180;

interface UseDeleteBoxDialogOptions {
  deleting: boolean;
}

export function useDeleteBoxDialog({ deleting }: UseDeleteBoxDialogOptions) {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleteDialogClosing, setIsDeleteDialogClosing] = useState(false);
  const [isDeleteBackdropClosing, setIsDeleteBackdropClosing] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const deleteDialogTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDeleteDialogTimer = useCallback(() => {
    if (deleteDialogTimeoutRef.current !== null) {
      clearTimeout(deleteDialogTimeoutRef.current);
      deleteDialogTimeoutRef.current = null;
    }
  }, []);

  const resetDeleteDialog = useCallback(() => {
    clearDeleteDialogTimer();
    setIsDeleteDialogOpen(false);
    setIsDeleteDialogClosing(false);
    setIsDeleteBackdropClosing(false);
    setDeleteConfirmText('');
  }, [clearDeleteDialogTimer]);

  const openDeleteDialog = useCallback(() => {
    clearDeleteDialogTimer();
    setDeleteConfirmText('');
    setIsDeleteDialogClosing(false);
    setIsDeleteBackdropClosing(false);
    setIsDeleteDialogOpen(true);
  }, [clearDeleteDialogTimer]);

  const closeDeleteDialog = useCallback(
    (afterClose?: () => void) => {
      if (!isDeleteDialogOpen || isDeleteDialogClosing) {
        return;
      }

      clearDeleteDialogTimer();
      setIsDeleteDialogClosing(true);
      setIsDeleteBackdropClosing(false);

      deleteDialogTimeoutRef.current = setTimeout(() => {
        setIsDeleteBackdropClosing(true);

        deleteDialogTimeoutRef.current = setTimeout(() => {
          resetDeleteDialog();
          afterClose?.();
        }, DELETE_BACKDROP_FADE_MS);
      }, DELETE_DIALOG_FADE_MS);
    },
    [clearDeleteDialogTimer, isDeleteDialogClosing, isDeleteDialogOpen, resetDeleteDialog]
  );

  useEffect(
    () => () => {
      clearDeleteDialogTimer();
    },
    [clearDeleteDialogTimer]
  );

  useEffect(() => {
    if (!isDeleteDialogOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isDeleteDialogClosing || deleting) {
        return;
      }

      event.preventDefault();
      closeDeleteDialog();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeDeleteDialog, deleting, isDeleteDialogClosing, isDeleteDialogOpen]);

  return {
    closeDeleteDialog,
    deleteConfirmText,
    isDeleteBackdropClosing,
    isDeleteConfirmUnlocked: deleteConfirmText.trim().toLowerCase() === 'delete',
    isDeleteDialogClosing,
    isDeleteDialogOpen,
    openDeleteDialog,
    resetDeleteDialog,
    setDeleteConfirmText
  };
}
