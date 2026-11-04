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
  set fs to character id 31
  tell application "Things3"
    set asList to areas
    set out to ""
    repeat with a in asList
      set aId to (id of a as string)
      set aName to my cleanVal(name of a)
      set row to aId & fs & aName
      if out is "" then
        set out to row
      else
        set out to out & rs & row
      end if
    end repeat
    return out
  end tell
end run
