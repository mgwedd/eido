on run argv
  if (count of argv) is 0 then return ""
  set todoId to item 1 of argv
  tell application "Things3"
    set t to to do id todoId
    set status of t to canceled
    return id of t
  end tell
end run
