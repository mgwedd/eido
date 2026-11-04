on cleanVal(v)
  try
    if v is missing value then return ""
    return v as string
  on error
    return ""
  end try
end cleanVal

on run argv
  set rs to character id 30
  tell application "Things3"
    set ts to tags
    set out to ""
    repeat with t in ts
      set tName to my cleanVal(name of t)
      if tName is not "" then
        if out is "" then
          set out to tName
        else
          set out to out & rs & tName
        end if
      end if
    end repeat
    return out
  end tell
end run
