<script lang="ts">
  import { onMount } from 'svelte';
  import { ChevronDown, GraduationCap } from 'lucide-svelte';
  import { tutorialRegistry, activeTutorial, startTutorial } from '../stores/tutorial';

  let dropdownOpen = $state(false);
  let glowing = $state(true);

  onMount(() => {
    const timer = setTimeout(() => { glowing = false; }, 3000);
    return () => clearTimeout(timer);
  });

  function handleSelect(id: string) {
    startTutorial(id);
    dropdownOpen = false;
    glowing = false;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if $tutorialRegistry.length > 0}
  <div class="relative">
    <button
      onclick={() => { dropdownOpen = !dropdownOpen; glowing = false; }}
      class="flex items-center gap-1.5 px-2 py-1 rounded
             text-gray-400 hover:text-term-cyan hover:bg-gray-800/60 transition-colors
             {glowing ? 'tutorial-glow' : ''}"
      title="Tutorials"
    >
      <GraduationCap size={13} class={glowing ? 'text-term-cyan' : ''} />
      <span class="hidden sm:inline text-[11px]">Learn</span>
      <ChevronDown size={12} class="hidden sm:inline text-gray-500" />
    </button>

    {#if dropdownOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="fixed inset-0 z-30" onclick={() => { dropdownOpen = false; }}></div>
      <div class="absolute top-full left-0 mt-1 z-40
                  bg-gray-950 border border-gray-700/80 rounded shadow-xl
                  min-w-[220px] py-1">
        {#each $tutorialRegistry as tut}
          <button
            onclick={() => handleSelect(tut.id)}
            disabled={$activeTutorial?.id === tut.id}
            class="flex flex-col w-full text-left px-3 py-2
                   transition-colors
                   {$activeTutorial?.id === tut.id
                     ? 'text-term-cyan bg-term-cyan/10 cursor-default'
                     : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'}"
          >
            <span class="text-[11px] font-medium">{tut.name}</span>
            <span class="text-[9px] text-gray-600 mt-0.5">{tut.description}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .tutorial-glow {
    animation: learn-glow 1.5s ease-in-out 3;
  }
  @keyframes learn-glow {
    0%, 100% {
      box-shadow: none;
    }
    50% {
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.5), 0 0 16px rgba(0, 229, 255, 0.2);
    }
  }
</style>
