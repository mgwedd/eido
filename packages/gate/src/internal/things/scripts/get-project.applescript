on zpad(n)
  set s to n as string
  if (count of s) is 1 then return "0" & s
  return s
end zpad

on isoDate(d)
  try
    if d is missing value then return ""
    set y to year of d as string
    set m to my zpad(month of d as integer)
    set dd to my zpad(day of d as integer)
    return y & "-" & m & "-" & dd
  on error
    return ""
  end try
end isoDate

on isoDateTime(d)
  try
    if d is missing value then return ""
    set y to year of d as string
    set m to my zpad(month of d as integer)
    set dd to my zpad(day of d as integer)
    set hh to (hours of d) as integer
    set mm to (minutes of d) as integer
    if hh is 0 and mm is 0 then
      return y & "-" & m & "-" & dd
    end if
    return y & "-" & m & "-" & dd & "T" & my zpad(hh) & ":" & my zpad(mm)
  on error
    return ""
  end try
end isoDateTime

on cleanVal(v)
  try
    if v is missing value then return ""
    return v as string
  on error
    return ""
  end try
end cleanVal

on run argv
  if (count of argv) is 0 then return ""
  set projId to item 1 of argv
  set fs to character id 31
  tell application "Things3"
    try
      set p to project id projId
    on error
      return ""
    end try
    set theArea to ""
    try
      set theArea to (name of area of p as string)
    end try
    set theStatus to (status of p) as string
    set headingNames to ""
    try
      set hs to {}
      repeat with h in headings of p
        set end of hs to (name of h as string)
      end repeat
      set AppleScript's text item delimiters to "|"
      set headingNames to hs as string
      set AppleScript's text item delimiters to ""
    end try
    set theCount to (count of to dos of p) as string
    set theTags to ""
    try
      set tagList to {}
      repeat with tg in tag names of p
        set end of tagList to (tg as string)
      end repeat
      set AppleScript's text item delimiters to ","
      set theTags to tagList as string
      set AppleScript's text item delimiters to ""
    end try
    return (id of p as string) & fs & ¬
      my cleanVal(name of p) & fs & ¬
      theArea & fs & ¬
      theStatus & fs & ¬
      headingNames & fs & ¬
      theCount & fs & ¬
      my cleanVal(notes of p) & fs & ¬
      my isoDate(due date of p) & fs & ¬
      my isoDateTime(activation date of p) & fs & ¬
      theTags
  end tell
end run
